Quixe = function() {

/* This is called by the page (or the page's display library) when it
   starts up. 
*/
function quixe_init() {
    setup_bytestring_table();
    setup_operandlist_table();

    //### catch exceptions
    setup_vm();
    execute_loop();
}

/* Log the message in the browser's error log, if it has one. (This shows
   up in Safari, in Opera, and in Firefox if you have Firebug installed.)
*/
function qlog(msg) {
    if (window.console && console.log)
        console.log(msg);
    else if (window.opera && opera.postError)
        opera.postError(msg);
}

function qobjdump(obj, depth) {
    var key, proplist;

    if (obj instanceof Array) {
        if (depth)
            depth--;
        var ls = obj.map(function(v) {return qobjdump(v, depth);});
        return ("[" + ls.join(",") + "]");
    }
    if (!(obj instanceof Object))
        return (""+obj);

    proplist = [ ];
    for (key in obj) {
        var val = obj[key];
        if (depth && val instanceof Object)
            val = qobjdump(val, depth-1);
        proplist.push(key + ":" + val);
    }
    return "{ " + proplist.join(", ") + " }";
}

var bytestring_table = Array(256);
function setup_bytestring_table() {
    var ix, val;
    for (ix=0; ix<0x100; ix++) {
        val = ix.toString(16);
        if (ix<0x10)
            val = "0" + val;
        bytestring_table[ix] = val;
    }
}

function ByteRead4(arr, addr) {
    return (arr[addr] << 24) + (arr[addr+1] << 16) 
        + (arr[addr+2] << 8) + (arr[addr+3]);
}

function Mem1(addr) {
    return memmap[addr];
}
function Mem2(addr) {
    return (memmap[addr] << 8) + (memmap[addr+1]);
}
function Mem4(addr) {
    return (memmap[addr] << 24) + (memmap[addr+1] << 16) 
        + (memmap[addr+2] << 8) + (memmap[addr+3]);
}
function SignMem1(addr) { //### needed?
    var val = memmap[addr];
    return (val & 0x80) ? (val |= 0xFFFFFF00) : val;
}
function SignMem2(addr) { //### needed?
    var val = (memmap[addr] << 8) + (memmap[addr+1]);
    return (val & 0x8000) ? (val |= 0xFFFF0000) : val;
}
function MemW1(addr, val) {
    // ignore high bytes if necessary
    memmap[addr] = val & 0xFF;
}
function MemW2(addr, val) {
    // ignore high bytes if necessary
    memmap[addr] = (val >> 8) & 0xFF;
    memmap[addr+1] = val & 0xFF;
}
function MemW4(addr, val) {
    memmap[addr]   = (val >> 24) & 0xFF;
    memmap[addr+1] = (val >> 16) & 0xFF;
    memmap[addr+2] = (val >> 8) & 0xFF;
    memmap[addr+3] = val & 0xFF;
}

function QuoteMem1(addr) {
    if (memmap[addr] >= 0x80)
        return "0xffffff" + bytestring_table[memmap[addr]];
    return "0x" + bytestring_table[memmap[addr]];
}
function QuoteMem2(addr) {
    if (memmap[addr] >= 0x80) 
        return "0xffff" + bytestring_table[memmap[addr]] + bytestring_table[memmap[addr+1]];
    if (memmap[addr]) 
        return "0x" + bytestring_table[memmap[addr]] + bytestring_table[memmap[addr+1]];
    return "0x" + bytestring_table[memmap[addr+1]];
}
function QuoteMem4(addr) {
    if (memmap[addr]) 
        return "0x" + bytestring_table[memmap[addr]] + bytestring_table[memmap[addr+1]] + bytestring_table[memmap[addr+2]] + bytestring_table[memmap[addr+3]];
    if (memmap[addr+1]) 
        return "0x" + bytestring_table[memmap[addr+1]] + bytestring_table[memmap[addr+2]] + bytestring_table[memmap[addr+3]];
    if (memmap[addr+2]) 
        return "0x" + bytestring_table[memmap[addr+2]] + bytestring_table[memmap[addr+3]];
    return "0x" + bytestring_table[memmap[addr+3]];
}

function fatal_error(msg) {
    var ix, val;
    if (arguments.length > 1) {
        msg += " (";
        for (ix = 1; ix < arguments.length; ix++) {
            val = arguments[ix]; //### val.toString(16)
            if (ix != 1)
                msg += " ";
            msg += val;
        }
        msg += ")";
    }
    qlog(msg);
    throw("### fatal error");
}

/* Turn a string containing JS statements into a function object that
   executes those statements. */
function make_code(val) {
    eval("function _func() {\n" + val + "\n}");
    return _func;
}

function VMFunc(funcaddr, startpc, localsformat, rawformat) {
    this.funcaddr = funcaddr;
    this.startpc = startpc;
    this.functype = Mem1(funcaddr); /* 0xC0 or 0xC1 */

    /* Addresses of all known (or predicted) paths for this function. */
    this.pathaddrs = {};
    /* The path tables for the various iosys modes. And yes, they are keyed
       on integers. */
    this[0] = {};
    this[1] = {};
    this[2] = {};

    this.locallen = null;
    this.localsformat = localsformat; /* array of {size, count} */
    this.rawformat = rawformat; /* array of bytes (multiple of 4) */
    this.localsindex = []; /* array of {size, pos} */

    /* Create a locals index, according to the format. This will 
       contain one {size, pos} per local.

       This is wacky, because it's not a simple list of values. A local is
       accessed by its byte position, assuming the "natural" four-byte word
       size. So the first (4-byte) local will be locals[0], the second will 
       be locals[4], and so on. In-between values will be undefined. */
    var ix, jx;
    var locallen = 0;
    for (ix=0; ix<this.localsformat.length; ix++) {
        var form = this.localsformat[ix];

        /* Pad to 4-byte or 2-byte alignment if these locals are 4 or 2
           bytes long. */
        if (form.size == 4) {
            while (locallen & 3)
                locallen++;
        }
        else if (form.size == 2) {
            while (locallen & 1)
                locallen++;
        }
        /* else no padding */

        for (jx=0; jx<form.count; jx++) {
            this.localsindex.push({ size:form.size, pos:locallen });
            locallen += form.size;
        }
    }

    /* Pad the locals to 4-byte alignment. */
    while (locallen & 3)
        locallen++;
    this.locallen = locallen;
}

function StackFrame(vmfunc) {
    var ix;

    this.vmfunc = vmfunc; /* the VMFunc that is running in this frame */
    this.depth = null;
    this.framestart = null; /* stack position where this frame starts */
    this.framelen = null; /* as in C */
    this.valstack = [];
    this.localspos = null; /* as in C */

    this.localsindex = vmfunc.localsindex;
    this.locals = [];

    /* Create a locals array, according to the index. All locals begin 
       with a value of zero. */
    for (ix=0; ix<this.localsindex.length; ix++) {
        var form = this.localsindex[ix];
        this.locals[form.pos] = 0;
    }

    this.framelen = 8 + vmfunc.rawformat.length + vmfunc.locallen;

    qlog("### frame for " + vmfunc.funcaddr.toString(16) + ": framelen " + this.framelen + ", locindex " + qobjdump(this.localsindex) + ", locals " + qobjdump(this.locals));
}

var operandlist_table = null;

function setup_operandlist_table() {
    function OperandList(formlist, argsize) {
        this.argsize = (argsize ? argsize : 4);
        this.numops = formlist.length;
        var ls = [];
        for (var ix=0; ix<formlist.length; ix++)
            ls.push(formlist[ix]);
        this.formlist = ls;
    }
    var list_none = new OperandList("");
    var list_L = new OperandList("L");
    var list_LL = new OperandList("LL");
    var list_LLL = new OperandList("LLL");
    var list_LS = new OperandList("LS");
    var list_LLS = new OperandList("LLS");
    var list_LLLLLLS = new OperandList("LLLLLLS");
    var list_LLLLLLLS = new OperandList("LLLLLLLS");
    var list_LC = new OperandList("LC");
    var list_LLC = new OperandList("LLC");
    var list_LLLC = new OperandList("LLLC");
    var list_LLLLC = new OperandList("LLLLC");
    var list_ES = new OperandList("ES");
    var list_LES = new OperandList("LES");
    var list_EES = new OperandList("EES");
    var list_F = new OperandList("F");
    var list_LF = new OperandList("LF");
    var list_EF = new OperandList("EF");
    var list_1EF = new OperandList("EF", 1);
    var list_2EF = new OperandList("EF", 2);
    var list_S = new OperandList("S");
    var list_SS = new OperandList("SS");
    var list_SL = new OperandList("SL");
    operandlist_table = { 
        0x00: list_none, /* nop */
        0x10: list_EES, /* add */
        0x11: list_LES, /* sub */
        0x12: list_LLS, /* mul */
        0x13: list_LLS, /* div */
        0x14: list_LLS, /* mod */
        0x15: list_ES, /* neg */
        0x18: list_EES, /* bitand */
        0x19: list_EES, /* bitor */
        0x1A: list_EES, /* bitxor */
        0x1B: list_ES, /* bitnot */
        0x1C: list_LLS, /* shiftl */
        0x1D: list_LLS, /* sshiftr */
        0x1E: list_LLS, /* ushiftr */
        0x20: list_L, /* jump */
        0x22: list_LL, /* jz */
        0x23: list_LL, /* jnz */
        0x24: list_LLL, /* jeq */
        0x25: list_LLL, /* jne */
        0x26: list_LLL, /* jlt */
        0x27: list_LLL, /* jge */
        0x28: list_LLL, /* jgt */
        0x29: list_LLL, /* jle */
        0x2A: list_LLL, /* jltu */
        0x2B: list_LLL, /* jgeu */
        0x2C: list_LLL, /* jgtu */
        0x2D: list_LLL, /* jleu */
        0x30: list_LLC, /* call */
        0x31: list_L, /* return */
        0x32: list_SL, /* catch */
        0x33: list_LL, /* throw */
        0x34: list_LL, /* tailcall */
        0x40: list_EF, /* copy */
        0x41: list_2EF, /* copys */
        0x42: list_1EF, /* copyb */
        0x44: list_LS, /* sexs */
        0x45: list_LS, /* sexb */
        0x48: list_LLS, /* aload */
        0x49: list_LLS, /* aloads */
        0x4A: list_LLS, /* aloadb */
        0x4B: list_LLS, /* aloadbit */
        0x4C: list_LLL, /* astore */
        0x4D: list_LLL, /* astores */
        0x4E: list_LLL, /* astoreb */
        0x4F: list_LLL, /* astorebit */
        0x50: list_F, /* stkcount */
        0x51: list_LF, /* stkpeek */
        0x52: list_none, /* stkswap */
        0x53: list_LL, /* stkroll */
        0x54: list_L, /* stkcopy */
        0x70: list_L, /* streamchar */
        0x71: list_L, /* streamnum */
        0x72: list_L, /* streamstr */
        0x73: list_L, /* streamunichar */
        0x100: list_LLS, /* gestalt */
        0x101: list_L, /* debugtrap */
        0x102: list_S, /* getmemsize */
        0x103: list_LS, /* setmemsize */
        0x104: list_L, /* jumpabs */
        0x110: list_LS, /* random */
        0x111: list_L, /* setrandom */
        0x120: list_none, /* quit */
        0x121: list_S, /* verify */
        0x122: list_none, /* restart */
        0x123: list_LS, /* save */
        0x124: list_LS, /* restore */
        0x125: list_S, /* saveundo */
        0x126: list_S, /* restoreundo */
        0x127: list_LL, /* protect */
        0x130: list_LLS, /* glk */
        0x140: list_S, /* getstringtbl */
        0x141: list_L, /* setstringtbl */
        0x148: list_SS, /* getiosys */
        0x149: list_LL, /* setiosys */
        0x150: list_LLLLLLLS, /* linearsearch */
        0x151: list_LLLLLLLS, /* binarysearch */
        0x152: list_LLLLLLS, /* linkedsearch */
        0x160: list_LC, /* callf */
        0x161: list_LLC, /* callfi */
        0x162: list_LLLC, /* callfii */
        0x163: list_LLLLC, /* callfiii */
        0x170: list_LL, /* mzero */
        0x171: list_LLL, /* mcopy */
        0x178: list_LS, /* malloc */
        0x179: list_L, /* mfree */
        0x180: list_LL, /* accelfunc */
        0x181: list_LL, /* accelparam */
    }
}

/* Some utility functions for opcode handlers. */

/* Store the result of an opcode, using the information specified in
   funcop. The operand may be a quoted constant, a holdvar, or an
   expression. (As usual, constants are identified by starting with a
   "0".)
*/
function oputil_store(context, funcop, operand) {
    switch (funcop.mode) {

    case 8: /* push on stack */
        if (quot_isconstant(operand) && funcop.argsize == 4) {
            /* If this is an untruncated constant, we can move it 
               directly to the offstack. */
            context.offstack.push(operand);
            context.code.push("// push to offstack: "+operand); //###debug
        }
        else {
            holdvar = alloc_holdvar(context, true);
            context.offstack.push(holdvar);
            if (funcop.argsize == 4) {
                context.code.push(holdvar+"=("+operand+");");
            }
            else if (funcop.argsize == 2) {
                context.code.push(holdvar+"=0xffff&("+operand+");");
            }
            else {
                context.code.push(holdvar+"=0xff&("+operand+");");
            }
        }
        return;

    case 0: /* discard value */
        context.code.push("("+operand+");");
        return;

    case 11: /* The local-variable cases. */
        if (funcop.argsize == 4) {
            context.code.push("frame.locals["+funcop.addr+"]=("+operand+");");
        }
        else if (funcop.argsize == 2) {
            context.code.push("frame.locals["+funcop.addr+"]=(0xffff &"+operand+");");
        }
        else {
            context.code.push("frame.locals["+funcop.addr+"]=(0xff &"+operand+");");
        }
        return;

    case 15: /* The main-memory cases. */
        if (funcop.argsize == 4) {
            context.code.push("MemW4("+funcop.addr+","+operand+");");
        }
        else if (funcop.argsize == 2) {
            context.code.push("MemW2("+funcop.addr+","+operand+");");
        }
        else {
            context.code.push("MemW1("+funcop.addr+","+operand+");");
        }
        return;

    default:
        fatal_error("Unknown addressing mode in store func operand.");

    }
}

/* Push the four-value call stub onto the stack. The operand should be the
   output of a "C" operand -- a string of the form "DESTTYPE,DESTADDR". 
*/
function oputil_push_callstub(context, operand) {
    context.code.push("frame.valstack.push("+operand+","+context.cp+",frame.framestart);");
}

/* Move all values on the offstack to the real stack. A handler should
   call this before any operation which requires a legal stack, and
   also before ending compilation. 

   If keepstack is true, this generates code to move the values, but
   leaves them on the offstack as well. Call this form before a conditional
   "return" which does not end compilation.
*/
function oputil_unload_offstack(context, keepstack) {
    context.code.push("// unload offstack: " + context.offstack.length + (keepstack ? " (conditional)" : "")); //###debug
    if (context.offstack.length) {
        context.code.push("frame.valstack.push("+context.offstack.join(",")+");");
        if (!keepstack) {
            var holdvar;
            while (context.offstack.length) {
                holdvar = context.offstack.pop();
                if (!(context.holduse[holdvar] === undefined))
                    context.holduse[holdvar] = false;
            }
            /* Now offstack is empty, and all its variables are marked not 
               on it. */
        }
    }
}

/* Return the signed equivalent of a value. If it is a high-bit constant, 
   this returns its negative equivalent as a constant. If it is a _hold
   variable, a new _hold is returned with the new (or old) value.
*/
function oputil_signify_operand(context, operand) {
    if (quot_isconstant(operand)) {
        var val = Number(operand);
        if (val & 0x80000000)
            return ""+(val - 0x100000000);
        else
            return operand;
    }
    var holdvar = alloc_holdvar(context);
    context.code.push(holdvar+"=(("+operand+"&0x80000000)?("+operand+"-0x100000000):("+operand+"));");
    return holdvar;
}

/* Generate code for a branch to operand. This includes the usual branch
   hack; 0 or 1 return from the current function. 
   If unconditional is false, the offstack values are left in place,
   so that compilation can continue.
*/
function oputil_perform_jump(context, operand, unconditional) {
    if (quot_isconstant(operand)) {
        var val = Number(operand);
        if (val == 0 || val == 1) {
            context.code.push("leave_function();");
            context.code.push("if (stack.length == 0) { done_executing = true; return; }");
            context.code.push("pop_callstub("+val+");");
        }
        else {
            var newpc = (context.cp+val-2) & 0xffffffff;
            context.code.push("pc = "+newpc+";");
            context.vmfunc.pathaddrs[newpc] = true;
        }
    }
    else {
        context.code.push("if (("+operand+")==0 || ("+operand+")==1) {");
        context.code.push("leave_function();");
        context.code.push("if (stack.length == 0) { done_executing = true; return; }");
        context.code.push("pop_callstub("+operand+");");
        context.code.push("}");
        context.code.push("else {");
        context.code.push("pc = ("+context.cp+"+("+operand+")-2) & 0xffffffff;");
        context.code.push("}");
    }
    oputil_unload_offstack(context, !unconditional);
    context.code.push("return;");
}

var opcode_table = {
    0x0: function(context, operands) { /* nop */
    },

    0x10: function(context, operands) { /* add */
        /* Commutative, so we don't care about the order of evaluation of
           the two expressions. */
        context.code.push(operands[2]+"(("+operands[0]+")+("+operands[1]+")) & 0xffffffff);");
    },

    0x11: function(context, operands) { /* sub */
        /* We hold operand 0, to ensure that it's evaluated first. Op 1
           is an expression. */
        context.code.push(operands[2]+"(("+operands[0]+")-("+operands[1]+")) & 0xffffffff);");
    },

    0x12: function(context, operands) { /* mul */
        var sign0 = oputil_signify_operand(context, operands[0]);
        var sign1 = oputil_signify_operand(context, operands[1]);
        context.code.push(operands[2]+"(("+sign0+")*("+sign1+")) & 0xffffffff);");
    },

    0x15: function(context, operands) { /* neg */
        context.code.push(operands[1]+"(-("+operands[0]+")) & 0xffffffff);");
    },

    0x18: function(context, operands) { /* bitand */
        /* Commutative. */
        context.code.push(operands[2]+"("+operands[0]+")&("+operands[1]+"));");
    },

    0x19: function(context, operands) { /* bitor */
        /* Commutative. */
        context.code.push(operands[2]+"("+operands[0]+")|("+operands[1]+"));");
    },

    0x1a: function(context, operands) { /* bitxor */
        /* Commutative. */
        context.code.push(operands[2]+"("+operands[0]+")^("+operands[1]+"));");
    },

    0x1b: function(context, operands) { /* bitnot */
        context.code.push(operands[1]+"(~("+operands[0]+")) & 0xffffffff);");
    },

    0x1c: function(context, operands) { /* shiftl */
        if (quot_isconstant(operands[1])) {
            var val = Number(operands[1]);
            if (val < 32)
                context.code.push(operands[2]+"(("+operands[0]+")<<"+val+") & 0xffffffff);");
            else
                context.code.push(operands[2]+"0);");
        }
        else {
            context.code.push(operands[2]+"("+operands[1]+"<32) ? (("+operands[0]+"<<"+operands[1]+") & 0xffffffff) : 0);");
        }
    },

    0x1d: function(context, operands) { /* sshiftr */
        if (quot_isconstant(operands[1])) {
            var val = Number(operands[1]);
            if (val < 32)
                context.code.push(operands[2]+"(("+operands[0]+")>>"+val+") & 0xffffffff);");
            else
                context.code.push(operands[2]+"(("+operands[0]+")&0x80000000) ? 0xffffffff : 0);");
        }
        else {
            context.code.push("if ("+operands[0]+" & 0x80000000) {");
            context.code.push(operands[2]+"("+operands[1]+"<32) ? (("+operands[0]+">>"+operands[1]+") & 0xffffffff) : 0xffffffff);");
            context.code.push("} else {");
            context.code.push(operands[2]+"("+operands[1]+"<32) ? (("+operands[0]+">>"+operands[1]+") & 0xffffffff) : 0);");
            context.code.push("}");
        }
    },

    0x1e: function(context, operands) { /* ushiftr */
        if (quot_isconstant(operands[1])) {
            var val = Number(operands[1]);
            if (val < 32)
                context.code.push(operands[2]+"(("+operands[0]+")>>>"+val+") & 0xffffffff);");
            else
                context.code.push(operands[2]+"0);");
        }
        else {
            context.code.push(operands[2]+"("+operands[1]+"<32) ? (("+operands[0]+">>>"+operands[1]+") & 0xffffffff) : 0);");
        }
    },

    0x20: function(context, operands) { /* jump */
        oputil_perform_jump(context, operands[0], true);
        context.path_ends = true;
    },

    0x104: function(context, operands) { /* jumpabs */
        if (quot_isconstant(operands[0])) {
            var newpc = Number(operands[0]);
            context.code.push("pc = "+newpc+";");
            context.vmfunc.pathaddrs[newpc] = true;
        }
        else {
            context.code.push("pc = "+operands[0]+";");
        }
        oputil_unload_offstack(context);
        context.code.push("return;");
        context.path_ends = true;
    },

    0x22: function(context, operands) { /* jz */
        context.code.push("if (("+operands[0]+")==0) {");
        oputil_perform_jump(context, operands[1]);
        context.code.push("}");
    },

    0x23: function(context, operands) { /* jnz */
        context.code.push("if (("+operands[0]+")!=0) {");
        oputil_perform_jump(context, operands[1]);
        context.code.push("}");
    },

    0x24: function(context, operands) { /* jeq */
        context.code.push("if (("+operands[0]+")==("+operands[1]+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x25: function(context, operands) { /* jne */
        context.code.push("if (("+operands[0]+")!=("+operands[1]+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x26: function(context, operands) { /* jlt */
        var sign0 = oputil_signify_operand(context, operands[0]);
        var sign1 = oputil_signify_operand(context, operands[1]);
        context.code.push("if (("+sign0+")<("+sign1+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x27: function(context, operands) { /* jge */
        var sign0 = oputil_signify_operand(context, operands[0]);
        var sign1 = oputil_signify_operand(context, operands[1]);
        context.code.push("if (("+sign0+")>=("+sign1+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x28: function(context, operands) { /* jgt */
        var sign0 = oputil_signify_operand(context, operands[0]);
        var sign1 = oputil_signify_operand(context, operands[1]);
        context.code.push("if (("+sign0+")>("+sign1+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x29: function(context, operands) { /* jle */
        var sign0 = oputil_signify_operand(context, operands[0]);
        var sign1 = oputil_signify_operand(context, operands[1]);
        context.code.push("if (("+sign0+")<=("+sign1+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x2a: function(context, operands) { /* jltu */
        context.code.push("if (("+operands[0]+")<("+operands[1]+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x2b: function(context, operands) { /* jgeu */
        context.code.push("if (("+operands[0]+")>=("+operands[1]+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x2c: function(context, operands) { /* jgtu */
        context.code.push("if (("+operands[0]+")>("+operands[1]+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x2d: function(context, operands) { /* jleu */
        context.code.push("if (("+operands[0]+")<=("+operands[1]+")) {");
        oputil_perform_jump(context, operands[2]);
        context.code.push("}");
    },

    0x30: function(context, operands) { /* call */
        if (quot_isconstant(operands[1])) {
            var ix;
            var argc = Number(operands[1]);
            for (ix=0; ix<argc; ix++) {
                if (context.offstack.length) {
                    var holdvar = pop_offstack_holdvar(context);
                    context.code.push("tempcallargs["+ix+"]="+holdvar+";");
                }
                else {
                    context.code.push("tempcallargs["+ix+"]=frame.valstack.pop();");
                }
            }
            oputil_unload_offstack(context);
        }
        else {
            context.varsused["ix"] = true;
            oputil_unload_offstack(context);
            context.code.push("for (ix=0; ix<"+operands[1]+"; ix++) { tempcallargs[ix]=frame.valstack.pop(); }");
        }
        oputil_push_callstub(context, operands[2]);
        context.code.push("enter_function("+operands[0]+", "+operands[1]+");");
        context.code.push("return;");
        context.path_ends = true;
    },

    0x34: function(context, operands) { /* tailcall */
        if (quot_isconstant(operands[1])) {
            var ix;
            var argc = Number(operands[1]);
            for (ix=0; ix<argc; ix++) {
                if (context.offstack.length) {
                    var holdvar = pop_offstack_holdvar(context);
                    context.code.push("tempcallargs["+ix+"]="+holdvar+";");
                }
                else {
                    context.code.push("tempcallargs["+ix+"]=frame.valstack.pop();");
                }
            }
            oputil_unload_offstack(context);
        }
        else {
            context.varsused["ix"] = true;
            oputil_unload_offstack(context);
            context.code.push("for (ix=0; ix<"+operands[1]+"; ix++) { tempcallargs[ix]=frame.valstack.pop(); }");
        }
        context.code.push("leave_function();");
        context.code.push("enter_function("+operands[0]+", "+operands[1]+");");
        context.code.push("return;");
        context.path_ends = true;
    },

    0x160: function(context, operands) { /* callf */
        oputil_unload_offstack(context);
        oputil_push_callstub(context, operands[1]);
        context.code.push("enter_function("+operands[0]+", 0);");
        context.code.push("return;");
        context.path_ends = true;
    },

    0x161: function(context, operands) { /* callfi */
        oputil_unload_offstack(context);
        context.code.push("tempcallargs[0]=("+operands[1]+");");
        oputil_push_callstub(context, operands[2]);
        context.code.push("enter_function("+operands[0]+", 1);");
        context.code.push("return;");
        context.path_ends = true;
    },

    0x162: function(context, operands) { /* callfii */
        oputil_unload_offstack(context);
        context.code.push("tempcallargs[0]=("+operands[1]+");");
        context.code.push("tempcallargs[1]=("+operands[2]+");");
        oputil_push_callstub(context, operands[3]);
        context.code.push("enter_function("+operands[0]+", 2);");
        context.code.push("return;");
        context.path_ends = true;
    },

    0x163: function(context, operands) { /* callfiii */
        oputil_unload_offstack(context);
        context.code.push("tempcallargs[0]=("+operands[1]+");");
        context.code.push("tempcallargs[1]=("+operands[2]+");");
        context.code.push("tempcallargs[2]=("+operands[3]+");");
        oputil_push_callstub(context, operands[4]);
        context.code.push("enter_function("+operands[0]+", 3);");
        context.code.push("return;");
        context.path_ends = true;
    },

    0x31: function(context, operands) { /* return */
        /* Quash the offstack; we're about to blow away the whole stack
           frame, so nothing of the stack will survive. */
        context.code.push("// quashing offstack for return: " + context.offstack.length); //###debug
        context.offstack.length = 0;
        context.code.push("leave_function();");
        context.code.push("if (stack.length == 0) { done_executing = true; return; }");
        context.code.push("pop_callstub("+operands[0]+");");
        context.code.push("return;");
        context.path_ends = true;
    },

    0x40: function(context, operands) { /* copy */
        oputil_store(context, operands[1], operands[0]);
    },

    0x41: function(context, operands) { /* copys */
        oputil_store(context, operands[1], operands[0]);
    },

    0x42: function(context, operands) { /* copyb */
        oputil_store(context, operands[1], operands[0]);
    },

    0x44: function(context, operands) { /* sexs */
        /* ### fold constant? */
        context.code.push(operands[1]+"("+operands[0]+" & 0x8000) ? ("+operands[0]+" | 0xffff0000) : ("+operands[0]+" & 0xffff));");
    },

    0x45: function(context, operands) { /* sexb */
        /* ### fold constant? */
        context.code.push(operands[1]+"("+operands[0]+" & 0x80) ? ("+operands[0]+" | 0xffffff00) : ("+operands[0]+" & 0xff));");
    },

    0x48: function(context, operands) { /* aload */
        var val, addr;
        if (quot_isconstant(operands[1])) {
            if (quot_isconstant(operands[0])) {
                /* Both operands constant */
                addr = Number(operands[0]) + Number(operands[1]) * 4;
                val = "Mem4("+(addr & 0xffffffff)+")";
            }
            else {
                var addr = Number(operands[1]) * 4;
                if (addr)
                    val = "Mem4(("+operands[0]+"+"+addr+") & 0xffffffff)";
                else
                    val = "Mem4("+operands[0]+")";
            }
        }
        else {
            val = "Mem4(("+operands[0]+"+4*"+operands[1]+") & 0xffffffff)";
        }
        context.code.push(operands[2]+val+");");
    },

    0x49: function(context, operands) { /* aloads */
        var val, addr;
        if (quot_isconstant(operands[1])) {
            if (quot_isconstant(operands[0])) {
                /* Both operands constant */
                addr = Number(operands[0]) + Number(operands[1]) * 2;
                val = "Mem2("+(addr & 0xffffffff)+")";
            }
            else {
                var addr = Number(operands[1]) * 2;
                if (addr)
                    val = "Mem2(("+operands[0]+"+"+addr+") & 0xffffffff)";
                else
                    val = "Mem2("+operands[0]+")";
            }
        }
        else {
            val = "Mem2(("+operands[0]+"+2*"+operands[1]+") & 0xffffffff)";
        }
        context.code.push(operands[2]+val+");");
    },

    0x4a: function(context, operands) { /* aloadb */
        var val, addr;
        if (quot_isconstant(operands[1])) {
            if (quot_isconstant(operands[0])) {
                /* Both operands constant */
                addr = Number(operands[0]) + Number(operands[1]);
                val = "Mem1("+(addr & 0xffffffff)+")";
            }
            else {
                var addr = Number(operands[1]);
                if (addr)
                    val = "Mem1(("+operands[0]+"+"+addr+") & 0xffffffff)";
                else
                    val = "Mem1("+operands[0]+")";
            }
        }
        else {
            val = "Mem1(("+operands[0]+"+"+operands[1]+") & 0xffffffff)";
        }
        context.code.push(operands[2]+val+");");
    },

    0x4c: function(context, operands) { /* astore */
        var val, addr;
        if (quot_isconstant(operands[1])) {
            if (quot_isconstant(operands[0])) {
                /* Both operands constant */
                addr = Number(operands[0]) + Number(operands[1]) * 4;
                val = (addr & 0xffffffff)+",";
            }
            else {
                var addr = Number(operands[1]) * 4;
                if (addr)
                    val = "("+operands[0]+"+"+addr+") & 0xffffffff"+",";
                else
                    val = operands[0]+",";
            }
        }
        else {
            val = "("+operands[0]+"+4*"+operands[1]+") & 0xffffffff"+",";
        }
        context.code.push("MemW4("+val+operands[2]+")"+";");
    },

    0x4d: function(context, operands) { /* astores */
        var val, addr;
        if (quot_isconstant(operands[1])) {
            if (quot_isconstant(operands[0])) {
                /* Both operands constant */
                addr = Number(operands[0]) + Number(operands[1]) * 2;
                val = (addr & 0xffffffff)+",";
            }
            else {
                var addr = Number(operands[1]) * 2;
                if (addr)
                    val = "("+operands[0]+"+"+addr+") & 0xffffffff"+",";
                else
                    val = operands[0]+",";
            }
        }
        else {
            val = "("+operands[0]+"+2*"+operands[1]+") & 0xffffffff"+",";
        }
        context.code.push("MemW2("+val+operands[2]+")"+";");
    },

    0x4e: function(context, operands) { /* astoreb */
        var val, addr;
        if (quot_isconstant(operands[1])) {
            if (quot_isconstant(operands[0])) {
                /* Both operands constant */
                addr = Number(operands[0]) + Number(operands[1]);
                val = (addr & 0xffffffff)+",";
            }
            else {
                var addr = Number(operands[1]);
                if (addr)
                    val = "("+operands[0]+"+"+addr+") & 0xffffffff"+",";
                else
                    val = operands[0]+",";
            }
        }
        else {
            val = "("+operands[0]+"+"+operands[1]+") & 0xffffffff"+",";
        }
        context.code.push("MemW1("+val+operands[2]+")"+";");
    },

    0x50: function(context, operands) { /* stkcount */
        var val;
        var count = context.offstack.length;
        if (count)
            val = "frame.valstack.length+" + count;
        else
            val = "frame.valstack.length";
        oputil_store(context, operands[0], val);
    },

    0x51: function(context, operands) { /* stkpeek */
        var val;
        if (quot_isconstant(operands[0])) {
            var pos = Number(operands[0]);
            if (pos < context.offstack.length) {
                val = context.offstack[context.offstack.length-(pos+1)];
            }
            else {
                val = "frame.valstack[frame.valstack.length-"+((pos+1)-context.offstack.length)+"]";
            }
        }
        else {
            oputil_unload_offstack(context);
            val = "frame.valstack[frame.valstack.length-("+operands[0]+"+1)]";
        }
        oputil_store(context, operands[1], val);
    },

    0x52: function(context, operands) { /* stkswap */
        var temp, len;
        if (context.offstack.length < 2) {
            transfer_to_offstack(context, 2);
        }
        /* We can do this with no code. */
        len = context.offstack.length;
        temp = context.offstack[len-1];
        context.offstack[len-1] = context.offstack[len-2];
        context.offstack[len-2] = temp;
    },

    0x53: function(context, operands) { /* stkroll */
        oputil_unload_offstack(context);
        context.varsused["ix"] = true;
        context.varsused["pos"] = true;
        context.varsused["roll"] = true;
        context.varsused["vals1"] = true;
        var sign0 = oputil_signify_operand(context, operands[0]);
        var sign1 = oputil_signify_operand(context, operands[1]);
        context.code.push("if ("+sign0+" > 0) {");
        context.code.push("if ("+sign1+" > 0) {");
        context.code.push("vals1 = "+sign1+" % "+sign0+";");
        context.code.push("} else {");
        context.code.push("vals1 = "+sign0+" - (-("+sign1+")) % "+sign0+";");
        context.code.push("}");
        context.code.push("if (vals1) {");
        context.code.push("pos = frame.valstack.length - "+sign0+";");
        context.code.push("roll = frame.valstack.slice(frame.valstack.length-vals1, frame.valstack.length).concat(frame.valstack.slice(pos, frame.valstack.length-vals1));");
        context.code.push("for (ix=0; ix<"+sign0+"; ix++) { frame.valstack[pos+ix] = roll[ix]; }");
        context.code.push("roll = undefined;");
        context.code.push("}");
        context.code.push("}");
    },

    0x54: function(context, operands) { /* stkcopy */
        oputil_unload_offstack(context);
        if (quot_isconstant(operands[0])) {
            var ix, holdvar;
            var pos = Number(operands[0]);
            for (ix=0; ix<pos; ix++) {
                holdvar = alloc_holdvar(context, true);
                context.offstack.push(holdvar);
                context.code.push(holdvar+"=frame.valstack[frame.valstack.length-"+(pos-ix)+"];");
            }
        }
        else {
            context.varsused["ix"] = true;
            context.varsused["jx"] = true;
            context.code.push("jx = frame.valstack.length-("+operands[0]+");");
            context.code.push("for (ix=0; ix<"+operands[0]+"; ix++) { frame.valstack.push(frame.valstack[jx+ix]); }");
        }
    },

    0x101: function(context, operands) { /* debugtrap */
        context.code.push("fatal_error('User debugtrap encountered.', "+operands[0]+");");
    },

    0x120: function(context, operands) { /* quit */
        /* Quash the offstack. No more execution. */
        context.code.push("// quashing offstack for quit: " + context.offstack.length); //###debug
        context.offstack.length = 0;
        context.code.push("done_executing = true;");
        context.code.push("return;");
        context.path_ends = true;
    },

}

/* Select a currently-unused "_hold*" variable, and mark it used. 
   If use is true, it's marked "1", meaning it's going onto the offstack. 
*/
function alloc_holdvar(context, use) {
    var ix = 0;
    var key;
    while (true) {
        key = "_hold" + ix;
        if (!context.holduse[key]) {
            context.holduse[key] = (use ? 1 : true);
            return key;
        }
        ix++;
    }
}

/* Remove a value from the offstack. If it is a constant, return it. If it 
   is a _hold var, mark it as not used by the offstack any more, and return 
   it (now a temporary holdvar). 
   (Do not call this if the offstack is empty.)
*/
function pop_offstack_holdvar(context) {
    var holdvar = context.offstack.pop();
    if (quot_isconstant(holdvar)) {
        return holdvar;
    }

    var use = context.holduse[holdvar];
    if (isNaN(use))
        fatal_error("Offstack variable not marked as stack.", holdvar); //###assert
    use--;
    if (use == 0)
        use = true; // Not on the stack any more
    context.holduse[holdvar] = use;
    return holdvar;
}

/* Transfer values from the real stack to the offstack until there are at
   least count on the offstack. (Do not call this if there are insufficient
   values on the real stack.)
*/
function transfer_to_offstack(context, count) {
    var holdvar;
    while (context.offstack.length < count) {
        holdvar = alloc_holdvar(context, true);
        context.offstack.unshift(holdvar);
        context.code.push(holdvar+"=frame.valstack.pop();");
    }
}

/* Check whether a quoted value is a constant. */
function quot_isconstant(val) {
    return (val[0] === "0");
}

/* Read the list of operands of an instruction, and put accessor code
   in operands. This assumes that the CP is at the beginning of the
   operand mode list (right after an opcode number.) Upon return,
   the CP will be at the beginning of the next instruction.

   The results go into operands[0], operands[1], etc. But these are not
   the values themselves; what you get are JS expressions which will
   generate them. The opcode handlers then insert these expressions
   into the code being generated.

   (At this stage, operands are always unsigned integers. A constant
   -1 comes out as "0xffffffff".)

   What you get depends on the operand type. The Glulx spec just
   has Load and Store operands, but this function handles a couple of
   variations.

   Load operand types:

   "E" (expression): The returned value is an arbitrary expression. It
   may have side effects, so the opcode handler must use the expression
   exactly once. If there are several "E" operands, the handler must
   use them in order.
   
   "L" (load): The returned value is either a numeric constant or a
   "_holdN" temporary variable. In the latter case, a line of the form
   "_holdN = EXPRESSION" has been inserted into the generated code
   (before the opcode handler's code). This is more expensive than
   "E", but safer, because the value will not have side effects.

   (Conveniently, "E" and "L" values can be categorized by their first
   character. Constants begin with "0"; temporary variables begin with
   "_"; anything else is a more complex expression.)

   Store operand types:

   "F" (function): The returned value is an object. When this is passed
   to oputil_store(), it will generate code to store the value. (Do not
   use more than one "F" per opcode.)

   "S" (store): The returned value is an expression of the form "FUNC(".
   Any expression can be appended, with a close-paren, to store a value
   in the desired place. This is faster than "F", but less flexible;
   it messes with the offstack in a confusing way, and also can't treat
   constants specially.

   "C" (callstub): The returned value is an expression of the form 
   "desttype,destaddr" -- two of the values in a Glulx call stub. The
   oputil_push_callstub() function knows how to generate code that pushes
   a call stub, if you pass these values in.
   
*/
function parse_operands(context, cp, oplist, operands) {
    var modeaddr;
    var ix, modeval, mode;
    var value, addr;
    var holdvar;

    operands.desttype = 0;
    operands.numops = oplist.numops;

    modeaddr = cp;
    cp += ((oplist.numops+1) >> 1);

    for (ix=0; ix<oplist.numops; ix++) {
        if ((ix & 1) == 0) {
            modeval = Mem1(modeaddr);
            mode = (modeval & 0x0F);
        }
        else {
            mode = ((modeval >> 4) & 0x0F);
            modeaddr++;
        }

        var optype = oplist.formlist[ix];

        if (optype == "L") {
            switch (mode) {

            case 8: /* pop off stack */
                if (context.offstack.length) {
                    operands[ix] = pop_offstack_holdvar(context);
                }
                else {
                    holdvar = alloc_holdvar(context);
                    context.code.push(holdvar+"=frame.valstack.pop();");
                    operands[ix] = holdvar;
                }
                continue;
                
            case 0: /* constant zero */
                operands[ix] = "0";
                continue;
                
            case 1: /* one-byte constant */
                /* Sign-extend from 8 bits to 32 */
                value = QuoteMem1(cp);
                cp++;
                operands[ix] = value;
                continue;
                
            case 2: /* two-byte constant */
                /* Sign-extend the first byte from 8 bits to 32; the subsequent
                   byte must not be sign-extended. */
                value = QuoteMem2(cp);
                cp += 2;
                operands[ix] = value;
                continue;
                
            case 3: /* four-byte constant */
                /* Bytes must not be sign-extended. */
                value = QuoteMem4(cp);
                cp += 4;
                operands[ix] = value;
                continue;
            }

            if (mode >= 9 && mode <= 11) {
                if (mode == 9) {
                    addr = Mem1(cp);
                    cp++;
                }
                else if (mode == 10) {
                    addr = Mem2(cp);
                    cp += 2;
                }
                else if (mode == 11) {
                    addr = Mem4(cp);
                    cp += 4;
                }

                if (oplist.argsize == 4) {
                    value = "frame.locals["+addr+"]";
                }
                else if (oplist.argsize == 2) {
                    value = "frame.locals["+addr+"] & 0xffff";
                }
                else {
                    value = "frame.locals["+addr+"] & 0xff";
                }
                holdvar = alloc_holdvar(context);
                context.code.push(holdvar+"=("+value+");");
                operands[ix] = holdvar;
                continue;
            }

            switch (mode) {
            case 15: /* main memory RAM, four-byte address */
                addr = Mem4(cp) + ramstart;
                cp += 4;
                break; 

            case 14: /* main memory RAM, two-byte address */
                addr = Mem2(cp) + ramstart;
                cp += 2;
                break; 

            case 13: /* main memory RAM, one-byte address */
                addr = Mem1(cp) + ramstart;
                cp++;
                break; 
        
            case 7: /* main memory, four-byte address */
                addr = Mem4(cp);
                cp += 4;
                break;

            case 6: /* main memory, two-byte address */
                addr = Mem2(cp);
                cp += 2;
                break;

            case 5: /* main memory, one-byte address */
                addr = Mem1(cp);
                cp++;
                break;

            default:
                fatal_error("Unknown addressing mode in load operand.");
            }

            /* The main-memory cases. */
            if (oplist.argsize == 4) {
                value = "Mem4("+addr+")";
            }
            else if (oplist.argsize == 2) {
                value = "Mem2("+addr+")";
            }
            else {
                value = "Mem1("+addr+")";
            }
            holdvar = alloc_holdvar(context);
            context.code.push(holdvar+"=("+value+");");
            operands[ix] = holdvar;
            continue;

        }
        else if (optype == "E") {
            switch (mode) {

            case 8: /* pop off stack */
                if (context.offstack.length) {
                    operands[ix] = pop_offstack_holdvar(context);
                }
                else {
                    operands[ix] = "frame.valstack.pop()";
                }
                continue;
                
            case 0: /* constant zero */
                operands[ix] = "0";
                continue;
                
            case 1: /* one-byte constant */
                /* Sign-extend from 8 bits to 32 */
                value = QuoteMem1(cp);
                cp++;
                operands[ix] = value;
                continue;
                
            case 2: /* two-byte constant */
                /* Sign-extend the first byte from 8 bits to 32; the subsequent
                   byte must not be sign-extended. */
                value = QuoteMem2(cp);
                cp += 2;
                operands[ix] = value;
                continue;
                
            case 3: /* four-byte constant */
                /* Bytes must not be sign-extended. */
                value = QuoteMem4(cp);
                cp += 4;
                operands[ix] = value;
                continue;
            }

            if (mode >= 9 && mode <= 11) {
                if (mode == 9) {
                    addr = Mem1(cp);
                    cp++;
                }
                else if (mode == 10) {
                    addr = Mem2(cp);
                    cp += 2;
                }
                else if (mode == 11) {
                    addr = Mem4(cp);
                    cp += 4;
                }

                if (oplist.argsize == 4) {
                    operands[ix] = "frame.locals["+addr+"]";
                }
                else if (oplist.argsize == 2) {
                    operands[ix] = "frame.locals["+addr+"] & 0xffff";
                }
                else {
                    operands[ix] = "frame.locals["+addr+"] & 0xff";
                }
                continue;
            }

            switch (mode) {
            case 15: /* main memory RAM, four-byte address */
                addr = Mem4(cp) + ramstart;
                cp += 4;
                break; 

            case 14: /* main memory RAM, two-byte address */
                addr = Mem2(cp) + ramstart;
                cp += 2;
                break; 

            case 13: /* main memory RAM, one-byte address */
                addr = Mem1(cp) + ramstart;
                cp++;
                break; 
        
            case 7: /* main memory, four-byte address */
                addr = Mem4(cp);
                cp += 4;
                break;

            case 6: /* main memory, two-byte address */
                addr = Mem2(cp);
                cp += 2;
                break;

            case 5: /* main memory, one-byte address */
                addr = Mem1(cp);
                cp++;
                break;

            default:
                fatal_error("Unknown addressing mode in load operand.");
            }

            /* The main-memory cases. */
            if (oplist.argsize == 4) {
                value = "Mem4("+addr+")";
            }
            else if (oplist.argsize == 2) {
                value = "Mem2("+addr+")";
            }
            else {
                value = "Mem1("+addr+")";
            }
            operands[ix] = value;
            continue;

        }
        else if (optype == "S") {
            switch (mode) {

            case 8: /* push on stack */
                /* Not on the actual stack, yet, but on the offstack. */
                holdvar = alloc_holdvar(context, true);
                context.offstack.push(holdvar);
                operands[ix] = holdvar+"=(";
                continue;
                
            case 0: /* discard value */
                operands[ix] = "(";
                continue;
            }
                
            if (mode >= 9 && mode <= 11) {
                if (mode == 9) {
                    addr = Mem1(cp);
                    cp++;
                }
                else if (mode == 10) {
                    addr = Mem2(cp);
                    cp += 2;
                }
                else if (mode == 11) {
                    addr = Mem4(cp);
                    cp += 4;
                }
                
                /* The local-variable cases. */
                if (oplist.argsize == 4) {
                    operands[ix] = "frame.locals["+addr+"]=(";
                }
                else if (oplist.argsize == 2) {
                    operands[ix] = "frame.locals["+addr+"]=(0xffff &";
                }
                else {
                    operands[ix] = "frame.locals["+addr+"]=(0xff &";
                }
                continue;
            }

            switch (mode) {
            case 15: /* main memory RAM, four-byte address */
                addr = Mem4(cp) + ramstart;
                cp += 4;
                break; 

            case 14: /* main memory RAM, two-byte address */
                addr = Mem2(cp) + ramstart;
                cp += 2;
                break; 

            case 13: /* main memory RAM, one-byte address */
                addr = Mem1(cp) + ramstart;
                cp++;
                break; 
        
            case 7: /* main memory, four-byte address */
                addr = Mem4(cp);
                cp += 4;
                break;

            case 6: /* main memory, two-byte address */
                addr = Mem2(cp);
                cp += 2;
                break;

            case 5: /* main memory, one-byte address */
                addr = Mem1(cp);
                cp++;
                break;

            default:
                fatal_error("Unknown addressing mode in store operand.");
            }

            /* The main-memory cases. */
            if (oplist.argsize == 4) {
                value = "MemW4("+addr+",";
            }
            else if (oplist.argsize == 2) {
                value = "MemW2("+addr+",";
            }
            else {
                value = "MemW1("+addr+",";
            }
            operands[ix] = value;
            continue;
        }
        else if (optype == "F") {
            var funcop = operands.func_store;

            switch (mode) {

            case 8: /* push on stack */
                funcop.mode = 8;
                funcop.argsize = oplist.argsize;
                operands[ix] = funcop;
                continue;
                
            case 0: /* discard value */
                funcop.mode = 0;
                funcop.argsize = oplist.argsize;
                operands[ix] = funcop;
                continue;
            }
                
            if (mode >= 9 && mode <= 11) {
                if (mode == 9) {
                    addr = Mem1(cp);
                    cp++;
                }
                else if (mode == 10) {
                    addr = Mem2(cp);
                    cp += 2;
                }
                else if (mode == 11) {
                    addr = Mem4(cp);
                    cp += 4;
                }
                
                /* The local-variable cases. */
                funcop.mode = 11;
                funcop.addr = addr;
                funcop.argsize = oplist.argsize;
                operands[ix] = funcop;
                continue;
            }

            switch (mode) {
            case 15: /* main memory RAM, four-byte address */
                addr = Mem4(cp) + ramstart;
                cp += 4;
                break; 

            case 14: /* main memory RAM, two-byte address */
                addr = Mem2(cp) + ramstart;
                cp += 2;
                break; 

            case 13: /* main memory RAM, one-byte address */
                addr = Mem1(cp) + ramstart;
                cp++;
                break; 
        
            case 7: /* main memory, four-byte address */
                addr = Mem4(cp);
                cp += 4;
                break;

            case 6: /* main memory, two-byte address */
                addr = Mem2(cp);
                cp += 2;
                break;

            case 5: /* main memory, one-byte address */
                addr = Mem1(cp);
                cp++;
                break;

            default:
                fatal_error("Unknown addressing mode in store operand.");
            }

            /* The main-memory cases. */
            funcop.mode = 15;
            funcop.addr = addr;
            funcop.argsize = oplist.argsize;
            operands[ix] = funcop;
            continue;
        }
        else if (optype == "C") {
            switch (mode) {

            case 8: /* push on stack */
                operands[ix] = "3,0";
                continue;
                
            case 0: /* discard value */
                operands[ix] = "0,0";
                continue;
            }
                
            if (mode >= 9 && mode <= 11) {
                if (mode == 9) {
                    addr = Mem1(cp);
                    cp++;
                }
                else if (mode == 10) {
                    addr = Mem2(cp);
                    cp += 2;
                }
                else if (mode == 11) {
                    addr = Mem4(cp);
                    cp += 4;
                }
                
                /* The local-variable cases. */
                operands[ix] = "2,"+addr;
                continue;
            }

            switch (mode) {
            case 15: /* main memory RAM, four-byte address */
                addr = Mem4(cp) + ramstart;
                cp += 4;
                break; 

            case 14: /* main memory RAM, two-byte address */
                addr = Mem2(cp) + ramstart;
                cp += 2;
                break; 

            case 13: /* main memory RAM, one-byte address */
                addr = Mem1(cp) + ramstart;
                cp++;
                break; 
        
            case 7: /* main memory, four-byte address */
                addr = Mem4(cp);
                cp += 4;
                break;

            case 6: /* main memory, two-byte address */
                addr = Mem2(cp);
                cp += 2;
                break;

            case 5: /* main memory, one-byte address */
                addr = Mem1(cp);
                cp++;
                break;

            default:
                fatal_error("Unknown addressing mode in store operand.");
            }

            /* The main-memory cases. */
            operands[ix] = "1,"+addr;
            continue;
        }
        else {
            fatal_error("Unknown operand type.", optype);
        }
    }

    return cp;
}

/* Construct a VMFunc for the function at the given address.
*/
function compile_func(funcaddr) {
    var addr = funcaddr;

    /* Check the Glulx type identifier byte. */
    var functype = Mem1(addr);
    if (functype != 0xC0 && functype != 0xC1) {
        if (functype >= 0xC0 && functype <= 0xDF)
            fatal_error("Call to unknown type of function.", addr);
        else
            fatal_error("Call to non-function.", addr);
    }
    addr++;
    
    /* Go through the function's locals-format list, and construct a
       slightly nicer description of the locals. (An array of [size, num].) */
    var localsformat = [];
    var rawstart = addr;
    var ix = 0;
    while (1) {
        /* Grab two bytes from the locals-format list. These are 
           unsigned (0..255 range). */
        var loctype = Mem1(addr);
        addr++;
        var locnum = Mem1(addr);
        addr++;

        if (loctype == 0) {
            break;
        }
        if (loctype != 1 && loctype != 2 && loctype != 4) {
            fatal_error("Invalid local variable size in function header.", loctype);
        }
        
        localsformat.push({ size:loctype, count:locnum });
    }

    /* We also copy the raw format list. This will be handy later on,
       when we need to serialize the stack. Note that it might be
       padded with extra zeroes to a four-byte boundary. */
    var rawformat = memmap.slice(rawstart, addr);
    while (rawformat.length % 4)
        rawformat.push(0);

    return new VMFunc(funcaddr, addr, localsformat, rawformat);
}

/* Construct a path for the given function starting at the given address.

   A path is a sequence of JS statements (eval'ed into a JS function)
   which implement the opcodes at that address. We compile as many
   opcodes as we efficiently can; compilation stops at the first
   call, return, unconditional branch, or so on. We also stop compilation
   if we reach an opcode which we know to be the *destination* of a
   branch. (The idea is that we're going to have to create a path
   starting there anyhow -- you can't jump into the middle of a JS
   function. So we avoid compiling those opcodes twice.)

   After executing a path, the VM state (pc, stack, etc) are set
   appropriately for the end of the path. However, we don't maintain
   that state opcode by opcode *inside* the path.
*/
function compile_path(vmfunc, startaddr, startiosys) {
    var cp = startaddr;
    var opcode;
    var opcodecp;
    var key;

    /* This will hold all sorts of useful information about the code
       sequence we're compiling. */
    var context = {
        vmfunc: vmfunc,

        cp: null, /* Will be filled in as we go */

        /* The iosysmode, as of cp. ### can handle computed values? */
        curiosys: startiosys,

        /* List of code lines. */
        code: [],

        /* Dict indicating which _hold variables are in use. A true value
           means that the variable is used in this opcode; false means
           it is not, but has been used before in the path; an integer
           means the variable is in use on offstack (N times). */
        holduse: {},

        /* Dict indicating which other ad-hoc variables are in use. */
        varsused: {},

        /* A stack of quoted values (constants and _hold variables)
           which should be on the value stack, but temporarily aren't. */
        offstack: [],

        /* Set true when no more opcodes should be compiled for this path. */
        path_ends: false,
    };

    /* This will hold the operand information for each opcode we compile.
       We'll recycle the object rather than allocating a new one each 
       time. */
    var operands = {};
    /* Another object to recycle. */
    operands.func_store = {};

    context.code.push(""); /* May be replaced by the _hold var declarations. */

    while (!context.path_ends) {

        /* Fetch the opcode number. */
        opcodecp = cp;
        opcode = Mem1(cp);
        if (opcode === undefined) 
            fatal_error("Tried to compile nonexistent address", cp);
        cp++;

        if (opcode & 0x80) {
            /* More than one-byte opcode. */
            if (opcode & 0x40) {
                /* Four-byte opcode */
                opcode &= 0x3F;
                opcode = (opcode << 8) | Mem1(cp);
                cp++;
                opcode = (opcode << 8) | Mem1(cp);
                cp++;
                opcode = (opcode << 8) | Mem1(cp);
                cp++;
            }
            else {
                /* Two-byte opcode */
                opcode &= 0x7F;
                opcode = (opcode << 8) | Mem1(cp);
                cp++;
            }
        }

        /* Now we have an opcode number. */
        context.code.push("// " + opcodecp.toString(16) + ": opcode " + opcode.toString(16)); //###debug

        /* Fetch the structure that describes how the operands for this
           opcode are arranged. This is a pointer to an immutable, 
           static object. */
        var oplist = operandlist_table[opcode];
        if (!oplist)
            fatal_error("Encountered unknown opcode.", opcode);
        cp = parse_operands(context, cp, oplist, operands);
        /* Some ophandlers need the next PC -- the address of the next
           instruction. That's cp right now. */
        context.cp = cp; 

        var ophandler = opcode_table[opcode];
        if (!ophandler)
            fatal_error("Encountered unhandled opcode.", opcode);
        //### worth a "with (context)..." here?
        ophandler(context, operands);

        /* Any _hold variables which were used in this opcode (only)
           are no longer used. Variables on the offstack are immune
           to this. */
        for (key in context.holduse) {
            if (context.holduse[key] === true)
                context.holduse[key] = false;
        }

        context.code.push("// offstack: " + context.offstack.join(",")); //###debug

        /* Check if any other compilation starts, or will start, at this
           address. If so, no need to compile further. */
        if (vmfunc.pathaddrs[cp] && !context.path_ends) {
            context.code.push("// reached jump-in point"); //###debug
            context.code.push("pc="+cp+";");
            oputil_unload_offstack(context);
            context.code.push("return;");
            context.path_ends = true;
        }
    }

    if (context.offstack.length) 
        fatal_error("Path compilation ended with nonempty offstack.", context.offstack.length);

    /* Declare all the _hold variables, and other variables, that we need. */
    {
        var ls = [];
        for (key in context.holduse)
            ls.push(key);
        for (key in context.varsused)
            ls.push(key);
        if (ls.length)
            context.code[0] = "var " + ls.join(",") + ";";
    }

    qlog("### code at " + startaddr.toString(16) + ":\n" + context.code.join("\n"));
    return make_code(context.code.join("\n"));
}

/* Prepare for execution of a new function. The argcount is the number
   of arguments passed in; the arguments themselves are in the 
   tempcallargs array. (We don't rely on tempcallargs.length, as that
   can be greater than argcount.)

   This puts a new call frame onto the stack, and fills in its locals
   (or valstack, for a 0xC0 function.) The pc is set to the function's
   starting address.
*/
function enter_function(addr, argcount) {
    var ix;

    //### acceleration

    var vmfunc = vmfunc_table[addr];
    if (vmfunc === undefined) {
        vmfunc = compile_func(addr);
        vmfunc_table[addr] = vmfunc;
    }

    pc = vmfunc.startpc;

    var newframe = new StackFrame(vmfunc);
    newframe.depth = stack.length;
    if (stack.length == 0)
        newframe.framestart = 0;
    else
        newframe.framestart = frame.framestart + frame.framelen + 4*frame.valstack.length;
    stack.push(newframe);
    frame = newframe;

    if (vmfunc.functype == 0xC0) {
        /* Push the function arguments on the stack. The locals have already
           been zeroed. */
        for (ix=argcount-1; ix >= 0; ix--)
            frame.valstack.push(tempcallargs[ix]);
        frame.valstack.push(argcount);
    }
    else {
        /* Copy in function arguments. This is a bit gross, since we have to
           follow the locals format. If there are fewer arguments than locals,
           that's fine -- we've already zeroed out this space. If there are
           more arguments than locals, the extras are silently dropped. */
        for (ix=0; ix<argcount; ix++) {
            var form = vmfunc.localsindex[ix];
            if (form === undefined)
                break;
            if (form.size == 4)
                frame.locals[form.pos] = tempcallargs[ix];
            else if (form.size == 2)
                frame.locals[form.pos] = tempcallargs[ix] & 0xFFFF;
            else if (form.size == 1)
                frame.locals[form.pos] = tempcallargs[ix] & 0xFF;
        }
    }

    qlog("### framestart " + frame.framestart + ", filled-in locals " + qobjdump(frame.locals) + ", valstack " + qobjdump(frame.valstack));
}

/* Pop the current call frame off the stack. This is very simple. */
function leave_function() {
    var olddepth = frame.depth;

    stack.pop();
    if (stack.length == 0) {
        frame = null;
        return;
    }
    frame = stack[stack.length-1];

    if (frame.depth != olddepth-1)
        fatal_error("Stack inconsistent after function exit.");
}

function pop_callstub(val) {
    var destaddr, desttype;

    qlog("### return value " + val.toString(16));
    if (isNaN(val))
        fatal_error("Function returned undefined value.");

    if (frame.valstack.pop() != frame.framestart)
        fatal_error("Call stub frameptr does not match frame.");
    pc = frame.valstack.pop();
    destaddr = frame.valstack.pop();
    desttype = frame.valstack.pop();

    switch (desttype) {
    case 0:
        return;
    case 1:
        MemW4(destaddr, val);
        return;
    case 2:
        frame.locals[destaddr] = val;
        return;
    case 3:
        frame.valstack.push(val);
        return;
    default:
        fatal_error("Unrecognized desttype in callstub.", desttype);
    }
}


/* The VM state variables */

var game_image = TEST_GAME_FILE;
var memmap; /* array of bytes */
var stack; /* array of StackFrames */
var frame; /* the top of the stack */
var tempcallargs; /* only used momentarily, for enter_function() */
var done_executing;

var vmfunc_table; /* maps addresses to VMFuncs */

/* Header constants. */
var ramstart;
var endgamefile;   // always game_image.length
var origendmem;
var stacksize;     // not used
var startfuncaddr;
var origstringtable;
var checksum;

/* The VM registers. */
var pc;
var stringtable;
var endmem;        // always memmap.length
var protectstart, protectend;
var iosysmode, iosysrock;

/* Set up all the initial VM state.
   ### where does game_image come from?
*/
function setup_vm() {
    var val, version;

    memmap = null;
    stack = [];
    frame = null;
    pc = 0;

    if (game_image.length < 36)
        fatal_error("This is too short to be a valid Glulx file.");
    val = ByteRead4(game_image, 0);
    if (val != 0x476c756c)   // 'Glul'
        fatal_error("This is not a valid Glulx file.");
    
    /* We support version 2.0 through 3.1.*. */
    version = ByteRead4(game_image, 4);
    if (version < 0x20000) 
        fatal_error("This Glulx file is too old a version to execute.");
    if (version >= 0x30200) 
        fatal_error("This Glulx file is too new a version to execute.");

    ramstart = ByteRead4(game_image, 8);
    endgamefile = ByteRead4(game_image, 12);
    origendmem = ByteRead4(game_image, 16);
    stacksize = ByteRead4(game_image, 20);
    startfuncaddr = ByteRead4(game_image, 24);
    origstringtable = ByteRead4(game_image, 28);
    checksum = ByteRead4(game_image, 32);

    /* Set the protection range to (0, 0), meaning "off". */
    protectstart = 0;
    protectend = 0;

    if (ramstart < 0x100 
        || endgamefile < ramstart 
        || origendmem < endgamefile) 
        fatal_error("The segment boundaries in the header are in an impossible order.");

    if (endgamefile != game_image.length)
        fatal_error("The game file length does not agree with the header.");

    done_executing = false;
    vmfunc_table = {};
    tempcallargs = []; //### Array(8)?
    //### glulx_setrandom(0);

    endmem = origendmem;
    stringtable = 0;

    vm_restart();
}

/* Put the VM into a state where it's ready to begin executing the
   game. This is called both at startup time, and when the machine
   performs a "restart" opcode. 
*/
function vm_restart() {
    var ix;

    //### deactivate heap
    //### reset memory to original size

    /* Build main memory array. */
    memmap = null; // garbage-collect old memmap
    memmap = game_image.slice(0, endgamefile); //### apply protection range!
    if (origendmem > endgamefile) {
        memmap.length = origendmem;
        for (ix=endgamefile; ix<origendmem; ix++)
            memmap[ix] = 0;
    }

    stack = [];
    frame = null;
    pc = 0;
    iosysmode = 0;
    iosysrock = 0;
    //### set_table(origstringtable);

    /* Note that we do not reset the protection range. */
    
    /* Push the first function call. (No arguments.) */
    enter_function(startfuncaddr, 0);
    
    /* We're now ready to execute. */
}

/* Begin executing code, compiling as necessary. If glk_select is invoked,
   this calls GlkOte.update() and exits. If, instead, the game ends, it
   just exits.
*/
function execute_loop() {
    var vmfunc, pathtab, path;

    while (!done_executing) {
        qlog("### pc now " + pc.toString(16));
        vmfunc = frame.vmfunc;
        pathtab = vmfunc[iosysmode];
        path = pathtab[pc];
        if (path === undefined) {
            vmfunc.pathaddrs[pc] = true;
            path = compile_path(vmfunc, pc, iosysmode);
            pathtab[pc] = path;
        }
        path();
    }

    qlog("### done executing.");
    //qlog("### " + qobjdump(vmfunc_table[0x48], 1));
}

return {
    version: '0.0.0',
    init: quixe_init,
};

}();
