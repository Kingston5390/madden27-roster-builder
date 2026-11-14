param([string]$List, [Parameter(Mandatory)][string]$Oodle)
# Batch version of madden27-qb-vision's casread.ps1: decode each line "cas<TAB>offset<TAB>size<TAB>originalSize<TAB>out" of -List
# with the game's own oo2core_9_win64.dll (-Oodle). Nothing in the game folder is modified.
if (-not ('Oo' -as [type])) {
$src = @"
using System; using System.IO; using System.Runtime.InteropServices;
public static class Oo {
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryW(string p);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr h, string n);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  delegate long DecFn(byte[] comp, long compSize, byte[] raw, long rawLen, int fuzz, int crc, int verb, IntPtr decBase, long decBaseSize, IntPtr cb, IntPtr cbData, IntPtr mem, long memSize, int phase);
  static DecFn dec;
  public static void Init(string dll) { if (dec != null) return; IntPtr h = LoadLibraryW(dll); if (h == IntPtr.Zero) throw new Exception("LoadLibrary failed " + Marshal.GetLastWin32Error());
    IntPtr f = GetProcAddress(h, "OodleLZ_Decompress"); if (f == IntPtr.Zero) throw new Exception("no OodleLZ_Decompress"); dec = (DecFn)Marshal.GetDelegateForFunctionPointer(f, typeof(DecFn)); }
  static uint BE(byte[] b, int o) { return (uint)(b[o] << 24 | b[o+1] << 16 | b[o+2] << 8 | b[o+3]); }
  public static string Decode(string cas, long off, int size, int orig, string outPath) {
    byte[] s = new byte[size]; using (var fs = File.OpenRead(cas)) { fs.Seek(off, SeekOrigin.Begin); int got = 0; while (got < size) { int n = fs.Read(s, got, size - got); if (n <= 0) throw new Exception("short read"); got += n; } }
    var ms = new MemoryStream(); int p = 0; string log = "";
    while (ms.Length < orig && p + 8 <= size) {
      uint a = BE(s, p), c = BE(s, p + 4); p += 8; int usize = (int)(a & 0xFFFFFF); int ct = (int)(c >> 24); int csize = (int)(c & 0xFFFFF);
      byte[] blk = new byte[csize]; Buffer.BlockCopy(s, p, blk, 0, csize); p += csize; byte[] o;
      if (ct == 0) o = blk;
      else if (ct == 0x11 || ct == 0x15 || ct == 0x19) { o = new byte[usize]; long r = dec(blk, csize, o, usize, 1, 0, 0, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, 3); if (r != usize) throw new Exception("oodle returned " + r + " want " + usize); }
      else throw new Exception("unsupported compression 0x" + ct.ToString("x") + " at block offset " + (p - 8 - csize));
      ms.Write(o, 0, o.Length); log += ct.ToString("x2") + ":" + csize + "->" + usize + " ";
    }
    File.WriteAllBytes(outPath, ms.ToArray()); return log + "total=" + ms.Length;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
}
[Oo]::Init($Oodle)
foreach ($l in Get-Content $List) { $f = $l -split "`t"; try { [void][Oo]::Decode($f[0], [long]$f[1], [int]$f[2], [int]$f[3], $f[4]) } catch { Write-Output ("ERR " + $f[4] + " " + $_) } }
