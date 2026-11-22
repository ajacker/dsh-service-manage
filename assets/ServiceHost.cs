// dsh-service-manage — minimal Windows service host.
//
// Windows refuses a plain `cmd.exe /c something.cmd` as a service binary: the
// process never talks to the Service Control Manager, so the start times out
// with error 1053. This host implements the SCM handshake, runs the generated
// launcher as a child, writes its output to <launcher>.service.log, and kills
// the whole child tree on stop.
//
// Built at install time from this file with the .NET Framework csc.exe that
// ships with Windows, so the plugin carries no third-party binary.

using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;

public sealed class DshServiceHost : ServiceBase
{
    private readonly string launcher;
    private readonly string logPath;
    private Process child;

    public DshServiceHost(string name, string launcher)
    {
        this.launcher = launcher;
        this.logPath = Path.ChangeExtension(launcher, ".service.log");
        this.ServiceName = name;
        this.CanStop = true;
        this.CanShutdown = true;
        this.AutoLog = false;
    }

    public static int Main(string[] args)
    {
        string name = "DSH-ServiceManage";
        string launcher = null;
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (string.Equals(args[i], "--launcher", StringComparison.OrdinalIgnoreCase)) launcher = args[i + 1];
            else if (string.Equals(args[i], "--name", StringComparison.OrdinalIgnoreCase)) name = args[i + 1];
        }
        if (launcher == null)
        {
            Console.Error.WriteLine("usage: ServiceHost.exe --name <service> --launcher <launcher.cmd>");
            return 2;
        }
        ServiceBase.Run(new DshServiceHost(name, launcher));
        return 0;
    }

    protected override void OnStart(string[] args)
    {
        Log("start " + launcher);
        try
        {
            var info = new ProcessStartInfo("cmd.exe", "/d /s /c \"\"" + launcher + "\"\"")
            {
                WorkingDirectory = Path.GetDirectoryName(launcher),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            var process = new Process();
            process.StartInfo = info;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += (sender, line) => Log(line.Data);
            process.ErrorDataReceived += (sender, line) => Log(line.Data);
            process.Exited += (sender, line) =>
            {
                Log("child exited with " + process.ExitCode);
                try { Stop(); }
                catch (Exception error) { Log("self-stop failed: " + error.Message); }
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            child = process;
        }
        catch (Exception error)
        {
            Log("start failed: " + error);
            throw;
        }
    }

    protected override void OnStop()
    {
        Log("stop");
        try
        {
            if (child == null || child.HasExited) return;
            var kill = new ProcessStartInfo("taskkill", "/PID " + child.Id + " /T /F")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process.Start(kill).WaitForExit(15000);
        }
        catch (Exception error)
        {
            Log("kill failed: " + error.Message);
        }
    }

    private void Log(string line)
    {
        if (line == null) return;
        try
        {
            File.AppendAllText(
                logPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine,
                Encoding.UTF8);
        }
        catch
        {
            // Losing a log line must never take the service down.
        }
    }
}
