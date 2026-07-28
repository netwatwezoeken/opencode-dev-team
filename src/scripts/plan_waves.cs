#:property PublishAot=false
// plan_waves.cs — compute parallel build waves from a plan's slice DAG.
//
// C# port of plan_waves.py / plan_parse.py (agentic-dev-team).
//
// Parses each slice's `Depends-on`, topologically layers the DAG into waves
// (wave 1 = slices with no prerequisites), detects same-wave file collisions,
// and returns a strongly-typed WavesPayload (serialisable to the plan-waves/v1
// JSON contract).
//
// Rejects (throws PlanWavesException with ExitCode 2):
//   - a dependency cycle
//   - a slice missing its Depends-on declaration
//   - an unknown dependency reference
//   - a plan containing no slice headings

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace DevTeam;

// ---------------------------------------------------------------------------
// Public exception type
// ---------------------------------------------------------------------------

/// <summary>Raised (exit-code 2) for all fatal plan-parsing errors.</summary>
public sealed class PlanWavesException : Exception
{
    public int ExitCode { get; } = 2;
    public PlanWavesException(string message) : base(message) { }
}

// ---------------------------------------------------------------------------
// Output model (plan-waves/v1)
// ---------------------------------------------------------------------------

public sealed class SliceInfo
{
    [JsonPropertyName("depends_on")]
    public List<string> DependsOn { get; set; } = new();

    [JsonPropertyName("files")]
    public List<string> Files { get; set; } = new();

    [JsonPropertyName("wave")]
    public int Wave { get; set; }
}

public sealed class Collision
{
    [JsonPropertyName("wave")]
    public int Wave { get; set; }

    [JsonPropertyName("slices")]
    public List<string> Slices { get; set; } = new();

    [JsonPropertyName("file")]
    public string File { get; set; } = "";
}

public sealed class ScopeMismatch
{
    [JsonPropertyName("slice")]
    public string Slice { get; set; } = "";

    [JsonPropertyName("declared")]
    public List<string> Declared { get; set; } = new();

    [JsonPropertyName("inferred")]
    public List<string> Inferred { get; set; } = new();

    [JsonPropertyName("under_declared")]
    public List<string> UnderDeclared { get; set; } = new();

    [JsonPropertyName("over_declared")]
    public List<string> OverDeclared { get; set; } = new();
}

public sealed class WavesPayload
{
    [JsonPropertyName("schema")]
    public string Schema { get; set; } = "plan-waves/v1";

    [JsonPropertyName("waves")]
    public List<List<string>> Waves { get; set; } = new();

    [JsonPropertyName("slices")]
    public Dictionary<string, SliceInfo> Slices { get; set; } = new();

    [JsonPropertyName("collisions")]
    public List<Collision> Collisions { get; set; } = new();

    [JsonPropertyName("scope_mismatches")]
    public List<ScopeMismatch> ScopeMismatches { get; set; } = new();
}

// ---------------------------------------------------------------------------
// PlanParser  (port of plan_parse.py)
// ---------------------------------------------------------------------------

/// <summary>
/// Parser for plan markdown files.  Mirrors the behaviour of plan_parse.py.
/// </summary>
public static class PlanParser
{
    // Regex mirrors
    private static readonly Regex SliceRe         = new(@"^#+\s+[Ss]lice\s+([^:]+)", RegexOptions.Compiled);
    private static readonly Regex StepRe          = new(@"^#{4,}\s", RegexOptions.Compiled);
    private static readonly Regex DependsRe       = new(@"[Dd]epends-[Oo]n\**\s*:\s*\**\s*(.*)", RegexOptions.Compiled);
    private static readonly Regex FilesRe         = new(@"[Ff]iles\**\s*:\s*\**\s*(.*)", RegexOptions.Compiled);
    private static readonly Regex BacktickTokenRe = new(@"`([^`]+)`", RegexOptions.Compiled);
    private static readonly Regex TokenSplitRe    = new(@"[,\s]+", RegexOptions.Compiled);

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /// <summary>
    /// Returns (id, depends, files) rows in source order.
    /// `depends` is the raw value, "none", or "__MISSING__" sentinel.
    /// </summary>
    public static List<(string Id, string Deps, string Files)> ParseSlices(IEnumerable<string> lines)
    {
        var rows = new List<(string, string, string)>();

        string currentId = "";
        string deps = "";
        bool depsSeen = false;
        string files = "";
        bool inStep = false;

        void Flush()
        {
            if (currentId.Length > 0)
                rows.Add((currentId, depsSeen ? deps : "__MISSING__", files));
        }

        foreach (var raw in lines)
        {
            var line = raw.TrimEnd('\n', '\r');

            if (SliceRe.IsMatch(line))
            {
                Flush();
                currentId = SliceId(line);
                deps = "";
                depsSeen = false;
                files = "";
                inStep = false;
                continue;
            }

            if (StepRe.IsMatch(line))
            {
                inStep = true;
                continue;
            }

            if (currentId.Length == 0 || inStep)
                continue;

            var lower = line.ToLowerInvariant();

            if (!depsSeen && lower.Contains("depends-on"))
            {
                var m = DependsRe.Match(line);
                if (m.Success)
                {
                    deps = CleanValue(m.Groups[1].Value);
                    depsSeen = true;
                    continue;
                }
            }

            if (files.Length == 0 && lower.Contains("files"))
            {
                var m = FilesRe.Match(line);
                if (m.Success)
                    files = CleanValue(m.Groups[1].Value);
            }
        }

        Flush();
        return rows;
    }

    /// <summary>
    /// Returns {sliceId → sorted tokenised inferred files} from per-step
    /// **Files**: lines (mirror of step_files_union).
    /// </summary>
    public static Dictionary<string, List<string>> StepFilesUnion(IEnumerable<string> lines)
    {
        var raw = ParseStepFiles(lines);
        var result = new Dictionary<string, List<string>>();
        foreach (var (sliceId, values) in raw)
        {
            var tokens = new HashSet<string>();
            foreach (var value in values)
            {
                foreach (var t in TokenSplitRe.Split(CleanValue(value)))
                    if (t.Length > 0) tokens.Add(t);
            }
            result[sliceId] = tokens.OrderBy(x => x).ToList();
        }
        return result;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    private static Dictionary<string, List<string>> ParseStepFiles(IEnumerable<string> lines)
    {
        var result = new Dictionary<string, List<string>>();
        string currentId = "";
        bool inStep = false;

        foreach (var raw in lines)
        {
            var line = raw.TrimEnd('\n', '\r');

            if (SliceRe.IsMatch(line))
            {
                currentId = SliceId(line);
                inStep = false;
                continue;
            }

            if (StepRe.IsMatch(line))
            {
                inStep = true;
                continue;
            }

            if (currentId.Length == 0 || !inStep)
                continue;

            if (line.ToLowerInvariant().Contains("files"))
            {
                var m = FilesRe.Match(line);
                if (m.Success)
                {
                    var value = m.Groups[1].Value.Trim();
                    if (value.Length > 0)
                    {
                        if (!result.ContainsKey(currentId))
                            result[currentId] = new List<string>();
                        result[currentId].Add(value);
                    }
                }
            }
        }

        return result;
    }

    internal static string SliceId(string headerLine)
    {
        var m = SliceRe.Match(headerLine);
        if (!m.Success) return "";
        var tail = m.Groups[1].Value;
        var colon = tail.IndexOf(':');
        return (colon >= 0 ? tail[..colon] : tail).Trim();
    }

    internal static string CleanValue(string raw)
    {
        var value = raw.Replace("`", "").Trim();
        if (value.StartsWith("**") && value.EndsWith("**") && value.Length > 3)
            value = value[2..^2].Trim();
        return value;
    }

    internal static bool IsGlob(string pattern) =>
        pattern.Contains('*') || pattern.Contains('?') || pattern.Contains('[');

    internal static bool GlobMatch(string pattern, string path)
    {
        // Convert fnmatch-style glob to a Regex (only * and ? need escaping)
        var regexStr = "^" + Regex.Escape(pattern)
            .Replace(@"\*\*", ".*")
            .Replace(@"\*", "[^/]*")
            .Replace(@"\?", ".") + "$";
        return Regex.IsMatch(path, regexStr);
    }
}

// ---------------------------------------------------------------------------
// PlanWaves  (port of plan_waves.py)
// ---------------------------------------------------------------------------

/// <summary>
/// Computes parallel build waves from a plan markdown's slice DAG.
/// </summary>
public static class PlanWaves
{
    private static readonly Regex TokenSplitRe = new(@"[,\s]+", RegexOptions.Compiled);

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /// <summary>
    /// Compute and return the plan-waves/v1 payload for the given plan text.
    /// Throws <see cref="PlanWavesException"/> (exit code 2) on fatal errors.
    /// </summary>
    public static WavesPayload ComputeWaves(string planText)
    {
        var planLines = planText.Split('\n');
        return ComputeWavesFromLines(planLines);
    }

    /// <summary>
    /// Convenience overload that reads the file at <paramref name="planPath"/>.
    /// </summary>
    public static WavesPayload ComputeWaves(string planPath, bool isFilePath)
    {
        if (!isFilePath) return ComputeWaves(planPath);
        return ComputeWaves(File.ReadAllText(planPath));
    }

    // ------------------------------------------------------------------
    // Core logic
    // ------------------------------------------------------------------

    private static WavesPayload ComputeWavesFromLines(IEnumerable<string> planLines)
    {
        var lineList = planLines.ToList();
        var rows = PlanParser.ParseSlices(lineList);
        var inferredBySlice = PlanParser.StepFilesUnion(lineList);

        // ---- Build slice map ----
        var slices = new Dictionary<string, SliceData>();
        var order = new List<string>();

        foreach (var (sid, depsRaw, filesRaw) in rows)
        {
            var files = TokenSplitRe.Split(filesRaw).Where(f => f.Length > 0).ToList();
            slices[sid] = new SliceData
            {
                DepsRaw = depsRaw,
                Files = files,
                InferredFiles = inferredBySlice.TryGetValue(sid, out var inf) ? inf : new List<string>(),
            };
            order.Add(sid);
        }

        if (slices.Count == 0)
            Die("no slices found (expected '### Slice <id>: ...' headings)");

        // ---- Validate Depends-on ----
        foreach (var sid in order)
        {
            var depsRaw = slices[sid].DepsRaw;
            if (depsRaw == "__MISSING__")
                Die($"slice '{sid}' is missing its Depends-on declaration — " +
                    "add 'Depends-on: none' if it has no prerequisites.");

            var raw = depsRaw.Trim();
            if (raw.Equals("none", StringComparison.OrdinalIgnoreCase) || raw.Length == 0)
                slices[sid].Deps = new List<string>();
            else
                slices[sid].Deps = TokenSplitRe.Split(raw).Where(d => d.Length > 0).ToList();
        }

        // ---- Validate references ----
        foreach (var sid in order)
        {
            foreach (var dep in slices[sid].Deps)
            {
                if (!slices.ContainsKey(dep))
                    Die($"slice '{sid}' depends on unknown slice '{dep}'.");
            }
        }

        // ---- Topological layering ----
        var remaining = order.ToDictionary(sid => sid, sid => new HashSet<string>(slices[sid].Deps));
        var waves = new List<List<string>>();
        var placed = new HashSet<string>();

        while (remaining.Count > 0)
        {
            var ready = remaining
                .Where(kv => kv.Value.IsSubsetOf(placed))
                .Select(kv => kv.Key)
                .OrderBy(s => s)
                .ToList();

            if (ready.Count == 0)
                Die("dependency cycle among slices: " + string.Join(", ", remaining.Keys.OrderBy(x => x)) + ".");

            waves.Add(ready);
            foreach (var s in ready)
            {
                placed.Add(s);
                remaining.Remove(s);
            }
        }

        var waveOf = waves
            .SelectMany((wave, i) => wave.Select(s => (s, i + 1)))
            .ToDictionary(t => t.s, t => t.Item2);

        // ---- Collision detection (conservative: declared ∪ inferred) ----
        var combinedFiles = order.ToDictionary(
            sid => sid,
            sid => new HashSet<string>(slices[sid].Files.Concat(slices[sid].InferredFiles)));

        var collisions = new List<Collision>();
        for (int wi = 0; wi < waves.Count; wi++)
        {
            var wave = waves[wi];
            for (int a = 0; a < wave.Count; a++)
            {
                for (int b = a + 1; b < wave.Count; b++)
                {
                    var shared = combinedFiles[wave[a]]
                        .Intersect(combinedFiles[wave[b]])
                        .OrderBy(f => f)
                        .ToList();
                    foreach (var f in shared)
                        collisions.Add(new Collision { Wave = wi + 1, Slices = new List<string> { wave[a], wave[b] }, File = f });
                }
            }
        }

        // ---- Scope mismatches ----
        var scopeMismatches = new List<ScopeMismatch>();
        foreach (var sid in order)
        {
            var declared = slices[sid].Files;
            if (declared.Count == 0) continue;
            var entry = ScopeMismatch(sid, declared, slices[sid].InferredFiles);
            if (entry != null) scopeMismatches.Add(entry);
        }

        // ---- Build result ----
        return new WavesPayload
        {
            Schema = "plan-waves/v1",
            Waves = waves,
            Slices = order.ToDictionary(
                sid => sid,
                sid => new SliceInfo
                {
                    DependsOn = slices[sid].Deps,
                    Files = slices[sid].Files,
                    Wave = waveOf[sid],
                }),
            Collisions = collisions,
            ScopeMismatches = scopeMismatches,
        };
    }

    // ------------------------------------------------------------------
    // Scope mismatch helper
    // ------------------------------------------------------------------

    private static ScopeMismatch? ScopeMismatch(string sid, List<string> declared, List<string> inferred)
    {
        var underDeclared = inferred
            .Where(f => !FileCovered(f, declared))
            .OrderBy(f => f)
            .ToList();
        var overDeclared = declared
            .Where(p => !PatternCoversAny(p, inferred))
            .OrderBy(p => p)
            .ToList();

        if (underDeclared.Count == 0 && overDeclared.Count == 0)
            return null;

        return new ScopeMismatch
        {
            Slice = sid,
            Declared = declared.OrderBy(x => x).ToList(),
            Inferred = inferred.OrderBy(x => x).ToList(),
            UnderDeclared = underDeclared,
            OverDeclared = overDeclared,
        };
    }

    private static bool FileCovered(string filePath, List<string> patterns)
    {
        foreach (var pattern in patterns)
        {
            if (pattern == filePath) return true;
            if (PlanParser.IsGlob(pattern) && PlanParser.GlobMatch(pattern, filePath)) return true;
        }
        return false;
    }

    private static bool PatternCoversAny(string pattern, List<string> files)
    {
        foreach (var file in files)
        {
            if (pattern == file) return true;
            if (PlanParser.IsGlob(pattern) && PlanParser.GlobMatch(pattern, file)) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Error helper
    // ------------------------------------------------------------------

    private static void Die(string message)
    {
        Console.Error.WriteLine("plan-waves: " + message);
        throw new PlanWavesException(message);
    }

    // ------------------------------------------------------------------
    // Internal data class
    // ------------------------------------------------------------------

    private sealed class SliceData
    {
        public string DepsRaw { get; set; } = "";
        public List<string> Deps { get; set; } = new();
        public List<string> Files { get; set; } = new();
        public List<string> InferredFiles { get; set; } = new();
    }
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

/// <summary>CLI entry point: plan-waves &lt;plan.md&gt;</summary>
public static class PlanWavesCli
{
    public static int Main(string[] args)
    {
        if (args.Length == 0 || !File.Exists(args[0]))
        {
            Console.Error.WriteLine("usage: plan-waves <plan.md>");
            return 2;
        }

        try
        {
            var payload = PlanWaves.ComputeWaves(File.ReadAllText(args[0]));
            var options = new JsonSerializerOptions { WriteIndented = true };
            Console.WriteLine(JsonSerializer.Serialize(payload, options));
            return 0;
        }
        catch (PlanWavesException)
        {
            return 2;
        }
    }
}
