// A stand-in Claude Code program for the isolated automatic-memory check
// (tools/automatic-e2e/run.mjs). The executor accepts a program file only, so
// this small .exe hands its arguments and standard streams to the scripted
// responder named in fake-host.cfg beside it: line 1 the Node binary, line 2
// the script. It makes no network call and reads no account state.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

class FakeHost {
  static int Main(string[] args) {
    string[] cfg = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fake-host.cfg"));
    var start = new ProcessStartInfo(cfg[0], "\"" + cfg[1] + "\"");
    start.UseShellExecute = false; start.CreateNoWindow = true;
    start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
    start.EnvironmentVariables["FAKE_HOST_ARGV"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\0", args)));
    var child = Process.Start(start);
    var output = new Thread(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
    var error = new Thread(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
    output.Start(); error.Start();
    try { Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream); } catch (IOException) { }
    try { child.StandardInput.Close(); } catch (IOException) { }
    child.WaitForExit(); output.Join(); error.Join();
    return child.ExitCode;
  }
}
