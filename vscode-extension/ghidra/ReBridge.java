// Script do Ghidra (headless) chamado por reBridge.js.
// Args: <arquivo-de-pedido> <arquivo-de-saida>. O pedido são linhas "chave=valor".
//@category Synk

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.plugin.assembler.Assembler;
import ghidra.app.plugin.assembler.Assemblers;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class ReBridge extends GhidraScript {

    private static final String ERROR_PREFIX = "[[RE_BRIDGE_ERROR]]";

    private Map<String, String> q = new HashMap<>();
    private StringBuilder out = new StringBuilder();

    private void error(String message) {
        out.append(ERROR_PREFIX)
            .append(" ")
            .append(message == null ? "erro desconhecido" : message)
            .append("\n");
    }

    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();

        if (a == null || a.length < 2) {
            throw new IllegalArgumentException(
                "Argumentos ausentes. Esperado: arquivo de pedido e arquivo de saída."
            );
        }

        try {
            for (String line : Files.readAllLines(Paths.get(a[0]), StandardCharsets.UTF_8)) {
                int i = line.indexOf('=');
                if (i > 0) {
                    q.put(line.substring(0, i), line.substring(i + 1));
                }
            }

            String op = q.getOrDefault("op", "");

            if (op.equals("info")) info();
            else if (op.equals("functions")) functions();
            else if (op.equals("decompile")) decompile();
            else if (op.equals("disasm")) disasm();
            else if (op.equals("xrefs")) xrefs();
            else if (op.equals("strings")) strings();
            else if (op.equals("asm")) asm();
            else if (op.equals("decompile-all")) decompileAll();
            else error("operação desconhecida: " + op);

        } catch (Exception e) {
            error(
                e.getClass().getSimpleName() + ": " +
                (e.getMessage() == null ? e.toString() : e.getMessage())
            );
        }

        Files.write(
            Paths.get(a[1]),
            out.toString().getBytes(StandardCharsets.UTF_8)
        );
    }

    private int num(String k, int def) {
        try { return Integer.parseInt(q.getOrDefault(k, "").trim()); } catch (Exception e) { return def; }
    }

    private boolean looksLikeAddress(String t) {
        return t.matches("(?i)0x[0-9a-f]+") || t.matches("(?i)[0-9a-f]{8,16}");
    }

    private Address addr(String t) {
        return currentProgram.getAddressFactory().getAddress(t.toLowerCase().startsWith("0x") ? t.substring(2) : t);
    }

    private Function findFunction(String t) {
        if (looksLikeAddress(t)) {
            Address ad = addr(t);
            Function f = ad == null ? null : currentProgram.getFunctionManager().getFunctionContaining(ad);
            if (f == null) error("nenhuma função contém " + t);
            return f;
        }
        String low = t.toLowerCase();
        List<Function> exact = new ArrayList<>(), part = new ArrayList<>();
        FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
        while (it.hasNext()) {
            Function f = it.next();
            String n1 = f.getName(), n2 = f.getName(true);
            if (n1.equalsIgnoreCase(t) || n2.equalsIgnoreCase(t)) exact.add(f);
            else if (n2.toLowerCase().contains(low)) part.add(f);
        }
        List<Function> pick = exact.isEmpty() ? part : exact;
        if (pick.isEmpty()) {
            error("nenhuma função encontrada para '" + t + "'. Use RE: functions filter=...");
            return null;
        }
        if (pick.size() == 1) return pick.get(0);
        error(pick.size() + " candidatas para '" + t + "'. Use o endereço (0x...):");
        for (int i = 0; i < Math.min(25, pick.size()); i++)
            out.append("  ").append(pick.get(i).getEntryPoint()).append("  ").append(pick.get(i).getName(true)).append("\n");
        return null;
    }

    private String fname(Address ad) {
        Function f = currentProgram.getFunctionManager().getFunctionContaining(ad);
        return f == null ? "(fora de função)" : f.getName(true) + " @ " + f.getEntryPoint();
    }

    private void info() {
        out.append("formato: ").append(currentProgram.getExecutableFormat()).append("\n");
        out.append("linguagem: ").append(currentProgram.getLanguageID()).append("\n");
        out.append("compilador: ").append(currentProgram.getCompilerSpec().getCompilerSpecID()).append("\n");
        out.append("imagebase: ").append(currentProgram.getImageBase()).append("\n");
        out.append("funções: ").append(currentProgram.getFunctionManager().getFunctionCount()).append("\n");
        out.append("seções:\n");
        for (MemoryBlock b : currentProgram.getMemory().getBlocks())
            out.append("  ").append(b.getName()).append("  ").append(b.getStart()).append("  tam=").append(b.getSize())
               .append("  ").append(b.isRead() ? "r" : "-").append(b.isWrite() ? "w" : "-").append(b.isExecute() ? "x" : "-").append("\n");
    }

    private void functions() {
        String f = q.getOrDefault("filter", q.getOrDefault("target", "")).toLowerCase();
        int limit = num("limit", 100), total = 0, shown = 0;
        FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
        while (it.hasNext()) {
            Function fn = it.next();
            String n = fn.getName(true);
            if (!f.isEmpty() && !n.toLowerCase().contains(f)) continue;
            total++;
            if (shown < limit) {
                out.append(fn.getEntryPoint()).append("  ").append(n).append("  (").append(fn.getBody().getNumAddresses()).append(" bytes)\n");
                shown++;
            }
        }
        out.append("-- ").append(shown).append(" de ").append(total).append(" função(ões)\n");
    }

    private void decompile() throws Exception {
        Function fn = findFunction(q.getOrDefault("target", ""));
        if (fn == null) return;
        DecompInterface di = new DecompInterface();
        try {
            di.openProgram(currentProgram);
            DecompileResults r = di.decompileFunction(fn, 90, monitor);
            out.append("// ").append(fn.getName(true)).append(" @ ").append(fn.getEntryPoint()).append("\n");
            if (!r.decompileCompleted()) {
                error("falha ao decompilar: " + r.getErrorMessage());
                return;
            }
            out.append(r.getDecompiledFunction().getC()).append("\n");
            out.append("-- chama:");
            for (Function c : fn.getCalledFunctions(monitor)) out.append(" ").append(c.getName(true)).append(";");
            out.append("\n-- chamada por:");
            for (Function c : fn.getCallingFunctions(monitor)) out.append(" ").append(c.getName(true)).append(";");
            out.append("\n");
        } finally {
            di.dispose();
        }
    }

    private void disasm() throws Exception {
        String t = q.getOrDefault("target", "");
        Address start;
        if (looksLikeAddress(t)) start = addr(t);
        else { Function f = findFunction(t); if (f == null) return; start = f.getEntryPoint(); }
        if (start == null) {
            error("endereço inválido");
            return;
        }
        Instruction ins = currentProgram.getListing().getInstructionContaining(start);
        if (ins == null) {
            error("sem instrução em " + start);
            return;
        }
        out.append("// ").append(fname(start)).append("\n");
        int count = Math.min(num("count", 40), 300);
        for (int i = 0; i < count && ins != null; i++, ins = ins.getNext()) {
            StringBuilder b = new StringBuilder();
            try { for (byte x : ins.getBytes()) b.append(String.format("%02X ", x)); } catch (Exception e) { b.append("?? "); }
            out.append(ins.getAddress()).append("  ").append(String.format("%-24s", b.toString().trim())).append("  ").append(ins).append("\n");
        }
    }

    private void xrefs() {
        String t = q.getOrDefault("target", "");
        Address to;
        if (looksLikeAddress(t)) to = addr(t);
        else { Function f = findFunction(t); if (f == null) return; to = f.getEntryPoint(); }
        if (to == null) {
            error("endereço inválido");
            return;
        }
        int n = 0;
        for (Reference r : currentProgram.getReferenceManager().getReferencesTo(to)) {
            if (n++ >= 80) { out.append("… (mais referências omitidas)\n"); break; }
            out.append(r.getFromAddress()).append("  ").append(r.getReferenceType()).append("  em ").append(fname(r.getFromAddress())).append("\n");
        }
        out.append("-- ").append(n).append(" referência(s) a ").append(to).append("\n");
    }

    private void strings() {
        String needle = q.getOrDefault("target", "").toLowerCase();
        int found = 0;
        DataIterator it = currentProgram.getListing().getDefinedData(true);
        while (it.hasNext() && found < 30) {
            Data d = it.next();
            if (!d.hasStringValue()) continue;
            Object v = d.getValue();
            if (v == null || !v.toString().toLowerCase().contains(needle)) continue;
            found++;
            out.append(d.getAddress()).append("  \"").append(v.toString().replace("\n", "\\n")).append("\"\n");
            int n = 0;
            for (Reference r : currentProgram.getReferenceManager().getReferencesTo(d.getAddress())) {
                if (n++ >= 10) break;
                out.append("    usada em ").append(r.getFromAddress()).append("  ").append(fname(r.getFromAddress())).append("\n");
            }
        }
        out.append("-- ").append(found).append(" string(s)").append(found == 30 ? " (limite)" : "").append("\n");
    }

    private void decompileAll() throws Exception {
        String f = q.getOrDefault("filter", "").toLowerCase();
        int limit = Math.max(1, Math.min(num("limit", 40), 200));
        int maxChars = Math.max(5000, Math.min(num("max_chars", 200_000), 5_000_000));
        DecompInterface di = new DecompInterface();
        try {
            di.openProgram(currentProgram);
            int shown = 0, total = 0, chars = 0;
            StringBuilder b = new StringBuilder();
            FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
            while (it.hasNext() && shown < limit) {
                Function fn = it.next();
                if (fn.isExternal() || fn.isThunk()) continue;
                String n = fn.getName(true);
                if (!f.isEmpty() && !n.toLowerCase().contains(f)) continue;
                total++;
                if (chars + 4000 > maxChars) {
                    b.append("\n// [limite de caracteres atingido; use RE: decompile para funções específicas]\n");
                    break;
                }
                DecompileResults r;
                try { r = di.decompileFunction(fn, 30, monitor); } catch (Exception e) { continue; }
                if (r == null || !r.decompileCompleted()) continue;
                String c = r.getDecompiledFunction().getC();
                if (c == null || c.isEmpty()) continue;
                if (c.length() > 8000) c = c.substring(0, 8000) + "\n// ... [função truncada; use RE: decompile target=" + fn.getEntryPoint() + "]\n";
                b.append("// === ").append(n).append(" @ ").append(fn.getEntryPoint()).append(" ===\n");
                b.append(c).append("\n\n");
                chars += c.length() + 100;
                shown++;
            }
            out.append("-- ").append(shown).append(" de ").append(total).append(" função(ões) decompiladas\n\n");
            out.append(b);
        } finally {
            di.dispose();
        }
    }

    private void asm() throws Exception {
        Address at = addr(q.getOrDefault("addr", ""));
        String text = q.containsKey("text") ? q.get("text") : q.getOrDefault("target", "");
        if (at == null) {
            error("addr inválido");
            return;
        }
        Assembler a = Assemblers.getAssembler(currentProgram);
        byte[] b = a.assembleLine(at, text);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02X ", x));
        out.append("\"").append(text).append("\" em ").append(at).append(" = ").append(s.toString().trim()).append("  (").append(b.length).append(" bytes)\n");
    }
}
