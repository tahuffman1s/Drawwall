using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using Microsoft.Win32;

namespace DrawWallAdmin;

public partial class MainWindow : Window
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

    private string Server => ServerBox.Text.TrimEnd('/');
    private string ApiKey => KeyBox.Text;

    public MainWindow() => InitializeComponent();

    // ── API call ──────────────────────────────────────────────────────────────

    private async Task CallCmd(string cmd, Dictionary<string, string>? extra = null)
    {
        var qs = new Dictionary<string, string> { ["key"] = ApiKey };
        if (extra != null)
            foreach (var (k, v) in extra) qs[k] = v;

        var query = string.Join("&", qs.Select(kv =>
            $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));

        var url = $"{Server}/admin/{cmd}?{query}";

        var label = extra != null
            ? $"{cmd.ToUpper()} {string.Join(" ", extra.Values)}"
            : cmd.ToUpper();

        Log($"> {label}");
        SetStatus($"Calling {cmd}…");

        try
        {
            var json = await Http.GetStringAsync(url);
            Log(FormatResponse(cmd, json));
            SetStatus("OK");
        }
        catch (HttpRequestException ex)
        {
            Log($"  HTTP error: {ex.StatusCode} — {ex.Message}");
            SetStatus("Error");
        }
        catch (TaskCanceledException)
        {
            Log("  Request timed out.");
            SetStatus("Timeout");
        }
        catch (Exception ex)
        {
            Log($"  Error: {ex.Message}");
            SetStatus("Error");
        }
    }

    // ── Response formatting ───────────────────────────────────────────────────

    private static string FormatResponse(string cmd, string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            // Array → user list
            if (root.ValueKind == JsonValueKind.Array)
            {
                var items = root.EnumerateArray().ToList();
                if (items.Count == 0) return "  (none)";
                var sb = new StringBuilder();
                foreach (var item in items)
                {
                    var id    = item.TryGetProperty("id",    out var v1) ? v1.GetString() ?? "" : "";
                    var name  = item.TryGetProperty("name",  out var v2) ? v2.GetString() ?? "" : "";
                    var color = item.TryGetProperty("color", out var v3) ? v3.GetString() ?? "" : "";
                    sb.AppendLine($"  [{id[..Math.Min(6, id.Length)]}]  {name,-20}  {color}");
                }
                return sb.ToString().TrimEnd();
            }

            // Object
            if (root.ValueKind == JsonValueKind.Object)
            {
                if (root.TryGetProperty("error", out var err))
                    return $"  Error: {err.GetString()}";

                if (root.TryGetProperty("msg", out var msg))
                    return $"  {msg.GetString()}";

                // Pretty-print key/value pairs
                var sb = new StringBuilder();
                foreach (var prop in root.EnumerateObject())
                    sb.AppendLine($"  {prop.Name,-16}: {prop.Value}");
                return sb.ToString().TrimEnd();
            }
        }
        catch { /* fall through */ }

        return "  " + json;
    }

    // ── Logging ───────────────────────────────────────────────────────────────

    private void Log(string text)
    {
        OutputBox.AppendText(text + "\n");
        OutputBox.ScrollToEnd();
    }

    private void SetStatus(string text) => StatusBar.Text = text;

    // ── Button handlers ───────────────────────────────────────────────────────

    private async void OnStatus(object s, RoutedEventArgs e)   => await CallCmd("status");
    private async void OnUsers(object s, RoutedEventArgs e)    => await CallCmd("users");
    private async void OnPixels(object s, RoutedEventArgs e)   => await CallCmd("pixels");

    private async void OnClear(object s, RoutedEventArgs e)
    {
        var result = MessageBox.Show(
            "This will wipe the canvas for ALL connected users.\n\nContinue?",
            "Confirm Clear Canvas",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);

        if (result == MessageBoxResult.Yes)
            await CallCmd("clear");
    }

    private async void OnKick(object s, RoutedEventArgs e)
    {
        var target = InputBox.Text.Trim();
        if (string.IsNullOrEmpty(target)) { Log("  Enter a user name or ID prefix first."); return; }
        await CallCmd("kick", new() { ["target"] = target });
    }

    private async void OnAnnounce(object s, RoutedEventArgs e)
    {
        var msg = InputBox.Text.Trim();
        if (string.IsNullOrEmpty(msg)) { Log("  Enter a message first."); return; }
        await CallCmd("announce", new() { ["msg"] = msg });
        InputBox.Clear();
    }

    private async void OnChat(object s, RoutedEventArgs e)
    {
        var msg = InputBox.Text.Trim();
        if (string.IsNullOrEmpty(msg)) { Log("  Enter a message first."); return; }
        await CallCmd("chat", new() { ["msg"] = msg });
        InputBox.Clear();
    }

    private async void OnExport(object s, RoutedEventArgs e)
    {
        var dlg = new SaveFileDialog
        {
            Title      = "Export Canvas",
            FileName   = $"drawwall-{DateTime.Now:yyyyMMdd-HHmmss}.json",
            DefaultExt = ".json",
            Filter     = "JSON canvas (*.json)|*.json",
        };
        if (dlg.ShowDialog() != true) return;

        Log("> EXPORT");
        SetStatus("Exporting…");
        try
        {
            var qs  = $"key={Uri.EscapeDataString(ApiKey)}";
            var url = $"{Server}/admin/export?{qs}";
            var json = await Http.GetStringAsync(url);
            await File.WriteAllTextAsync(dlg.FileName, json);
            var count = JsonDocument.Parse(json).RootElement.EnumerateObject().Count();
            Log($"  Saved {count:N0} pixels → {dlg.FileName}");
            SetStatus("Exported");
        }
        catch (Exception ex) { Log($"  Error: {ex.Message}"); SetStatus("Error"); }
    }

    private async void OnImport(object s, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Title      = "Import Canvas",
            DefaultExt = ".json",
            Filter     = "JSON canvas (*.json)|*.json",
        };
        if (dlg.ShowDialog() != true) return;

        var result = MessageBox.Show(
            $"Replace the live canvas with \"{Path.GetFileName(dlg.FileName)}\"?\n\nThis will clear all current pixels.",
            "Confirm Import",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);
        if (result != MessageBoxResult.Yes) return;

        Log($"> IMPORT {Path.GetFileName(dlg.FileName)}");
        SetStatus("Importing…");
        try
        {
            var json    = await File.ReadAllTextAsync(dlg.FileName);
            var pixels  = JsonSerializer.Deserialize<Dictionary<string, string>>(json)
                          ?? throw new Exception("Invalid canvas file");
            var qs      = $"key={Uri.EscapeDataString(ApiKey)}";
            var url     = $"{Server}/admin/import?{qs}";
            var content = new StringContent(json, Encoding.UTF8, "application/json");
            var resp    = await Http.PostAsync(url, content);
            var body    = await resp.Content.ReadAsStringAsync();
            Log(FormatResponse("import", body));
            SetStatus("Imported");
        }
        catch (Exception ex) { Log($"  Error: {ex.Message}"); SetStatus("Error"); }
    }

    private void OnClearLog(object s, RoutedEventArgs e) => OutputBox.Clear();

    private async void OnInputKeyDown(object s, KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Enter) await CallCmd("chat", new() { ["msg"] = InputBox.Text.Trim() });
    }
}
