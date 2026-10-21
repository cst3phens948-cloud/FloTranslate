using System.Text.Json;
using System.Text.RegularExpressions;
using FloState.Web.Data;
using FloState.Web.Models;
using FloState.Web.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace FloState.Web.Controllers;

public sealed class ComicsController(ComicDbContext db, IWebHostEnvironment environment, OpenAiComicTranslator translator, IDataProtectionProvider protection) : Controller
{
    private string PageDirectory => Path.Combine(environment.ContentRootPath, "App_Data", "pages");
    private ITimeLimitedDataProtector ResearchProtector => protection.CreateProtector("FloState.Research.v1").ToTimeLimitedDataProtector();

    public async Task<IActionResult> Index()
    {
        var comics = await db.Comics.AsNoTracking()
            .Include(c => c.Chapters).ThenInclude(chapter => chapter.Pages)
            .OrderBy(c => c.Title)
            .ToListAsync();
        return View(comics);
    }

    public IActionResult Create() => View(new Comic());

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(Comic comic)
    {
        if (!ModelState.IsValid) return View(comic);
        comic.Title = comic.Title.Trim(); comic.SourceLanguage = comic.SourceLanguage.Trim(); comic.TargetLanguage = comic.TargetLanguage.Trim();
        db.Comics.Add(comic); await db.SaveChangesAsync();
        return RedirectToAction(nameof(Details), new { id = comic.Id });
    }

    public async Task<IActionResult> Details(int id, int? analyzeChapter = null)
    {
        var comic = await db.Comics.Include(c => c.ContextEntries).Include(c => c.Chapters).ThenInclude(c => c.Pages).FirstOrDefaultAsync(c => c.Id == id);
        if (comic is null)
        {
            return NotFound();
        }
        comic.ContextEntries = comic.ContextEntries.OrderBy(e => e.Kind).ThenBy(e => e.Term).ToList();
        comic.Chapters = comic.Chapters.OrderBy(c => c.Number).ToList();
        foreach (var chapter in comic.Chapters)
        {
            chapter.Pages = chapter.Pages.OrderBy(p => p.Number).ToList();
        }
        ViewData["AnalyzeChapter"] = analyzeChapter;
        return View(comic);
    }

    public async Task<IActionResult> Read(int id)
    {
        var comic = await db.Comics.AsNoTracking().Include(c => c.Chapters).ThenInclude(c => c.Pages)
            .FirstOrDefaultAsync(c => c.Id == id);
        if (comic is null)
        {
            return NotFound();
        }
        comic.Chapters = comic.Chapters.OrderBy(c => c.Number).ToList();
        foreach (var chapter in comic.Chapters)
        {
            chapter.Pages = chapter.Pages.OrderBy(p => p.Number).ToList();
        }
        return View(comic);
    }

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> AddChapter(int comicId, int number, string title)
    {
        if (!await db.Comics.AnyAsync(c => c.Id == comicId)) return NotFound();
        if (number < 1 || string.IsNullOrWhiteSpace(title) || title.Length > 160 || await db.Chapters.AnyAsync(c => c.ComicId == comicId && c.Number == number))
        { TempData["Error"] = "Enter a unique positive chapter number and a title (up to 160 characters)."; return RedirectToAction(nameof(Details), new { id = comicId }); }
        db.Chapters.Add(new Chapter { ComicId = comicId, Number = number, Title = title.Trim() });
        await db.SaveChangesAsync(); return RedirectToAction(nameof(Details), new { id = comicId });
    }

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> AddContext(int comicId, string kind, string term, string translation, string? notes)
    {
        if (!await db.Comics.AnyAsync(c => c.Id == comicId)) return NotFound();
        if (string.IsNullOrWhiteSpace(term) || string.IsNullOrWhiteSpace(translation) || term.Length > 160 || translation.Length > 160 || notes?.Length > 1000 || !new[] { "Character", "Nickname", "Place", "Term", "Style" }.Contains(kind))
        { TempData["Error"] = "Check the context entry fields and try again."; return RedirectToAction(nameof(Details), new { id = comicId }); }
        db.ContextEntries.Add(new ContextEntry { ComicId = comicId, Kind = kind, Term = term.Trim(), Translation = translation.Trim(), Notes = notes?.Trim() });
        await db.SaveChangesAsync(); return RedirectToAction(nameof(Details), new { id = comicId });
    }

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> ResearchComic(int id, CancellationToken cancellationToken)
    {
        var comic = await db.Comics.AsNoTracking().FirstOrDefaultAsync(c => c.Id == id, cancellationToken);
        if (comic is null) return NotFound();
        try
        {
            var result = await translator.ResearchAsync(comic, cancellationToken);
            var receipt = result.Sources.Count > 0
                ? ResearchProtector.Protect(JsonSerializer.Serialize(new ResearchReceipt(id, result.Summary, result.Sources)), TimeSpan.FromHours(1))
                : null;
            return Json(new { result.Summary, result.Sources, receipt });
        }
        catch (AiTranslationException ex) { return BadRequest(new { error = ex.Message }); }
        catch (HttpRequestException) { return StatusCode(502, new { error = "Could not reach OpenAI. Try again later." }); }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { return StatusCode(504, new { error = "OpenAI took too long to respond." }); }
        catch (JsonException) { return StatusCode(502, new { error = "OpenAI returned an unreadable research result." }); }
    }

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> AcceptResearch(int id, string receipt, CancellationToken cancellationToken)
    {
        ResearchReceipt? research;
        try { research = JsonSerializer.Deserialize<ResearchReceipt>(ResearchProtector.Unprotect(receipt)); }
        catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or JsonException or ArgumentException)
        { return BadRequest(new { error = "This research result expired. Search again." }); }
        if (research is null || research.ComicId != id || research.Sources.Count == 0 || research.Summary.Length > 6000)
            return BadRequest(new { error = "Invalid research result." });
        var comic = await db.Comics.Include(c => c.ContextEntries).FirstOrDefaultAsync(c => c.Id == id, cancellationToken);
        if (comic is null) return NotFound();
        if (comic.ContextEntries.Count >= 300) return BadRequest(new { error = "This comic has reached the context limit." });
        var source = research.Sources[0].Url;
        if (source.Length > 300) return BadRequest(new { error = "The cited URL is too long to save as context." });
        var summary = research.Summary.Length > 600 ? research.Summary[..600] + "…" : research.Summary;
        db.ContextEntries.Add(new ContextEntry { ComicId = id, Kind = "Reference", Term = "Source material",
            Translation = comic.Title, Notes = $"AI web research (reviewed): {summary} Source: {source}" });
        await db.SaveChangesAsync(cancellationToken);
        return Ok(new { saved = true });
    }

    private sealed record ResearchReceipt(int ComicId, string Summary, List<AiResearchSource> Sources);

    [HttpPost, ValidateAntiForgeryToken, RequestSizeLimit(200_000_000)]
    public async Task<IActionResult> UploadPages(int chapterId, List<IFormFile>? images, bool analyzeAfterUpload = false)
    {
        var chapter = await db.Chapters.FindAsync(chapterId);
        if (chapter is null)
        {
            return NotFound();
        }
        if (images is null || images.Count is < 1 or > 50 || images.Any(file => file.Length is < 1 or > 20_000_000) || images.Sum(file => file.Length) > 190_000_000)
        {
            TempData["Error"] = "Choose 1–50 images, each under 20 MB, with a total under 190 MB.";
            return RedirectToAction(nameof(Details), new { id = chapter.ComicId });
        }
        var saved = new List<string>();
        try
        {
            Directory.CreateDirectory(PageDirectory);
            var number = (await db.Pages.Where(p => p.ChapterId == chapterId).MaxAsync(p => (int?)p.Number) ?? 0) + 1;
            foreach (var file in images.OrderBy(f => NaturalFileNameKey(f.FileName), StringComparer.OrdinalIgnoreCase))
            {
                var type = await DetectImageType(file);
                if (type is null)
                {
                    throw new InvalidDataException("Only valid PNG, JPEG, and WebP images are supported.");
                }
                var name = Guid.NewGuid().ToString("N") + (type == "image/png" ? ".png" : type == "image/jpeg" ? ".jpg" : ".webp");
                var path = Path.Combine(PageDirectory, name);
                await using (var output = System.IO.File.Create(path))
                {
                    await file.CopyToAsync(output);
                }
                saved.Add(path);
                db.Pages.Add(new ComicPage { ChapterId = chapterId, Number = number++, OriginalFileName = Path.GetFileName(file.FileName), StorageName = name, ContentType = type });
            }
            await db.SaveChangesAsync();
            return RedirectToAction(nameof(Details), new { id = chapter.ComicId, analyzeChapter = analyzeAfterUpload ? chapterId : (int?)null });
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException)
        {
            foreach (var path in saved)
            {
                System.IO.File.Delete(path);
            }
            TempData["Error"] = ex.Message;
        }
        return RedirectToAction(nameof(Details), new { id = chapter.ComicId });
    }

    private static string NaturalFileNameKey(string name)
    {
        return Regex.Replace(Path.GetFileName(name), @"\d+", match => match.Value.PadLeft(16, '0'));
    }

    private static async Task<string?> DetectImageType(IFormFile file)
    {
        var bytes = new byte[12];
        await using var input = file.OpenReadStream();
        if (await input.ReadAsync(bytes) < 12) return null;
        if (bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137,80,78,71,13,10,26,10 })) return "image/png";
        if (bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255) return "image/jpeg";
        if (bytes.AsSpan(0,4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8,4).SequenceEqual("WEBP"u8)) return "image/webp";
        return null;
    }

    public async Task<IActionResult> PageImage(int id)
    {
        var page = await db.Pages.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id);
        if (page is null) return NotFound();
        var path = Path.Combine(PageDirectory, page.StorageName);
        if (!System.IO.File.Exists(path)) return NotFound();
        Response.Headers.CacheControl = "private, max-age=3600";
        return PhysicalFile(path, page.ContentType);
    }

    public async Task<IActionResult> EditPage(int id)
    {
        var page = await db.Pages.Include(p => p.Chapter).ThenInclude(c => c.Comic).FirstOrDefaultAsync(p => p.Id == id);
        if (page is null) return NotFound();
        ViewData["AiConfigured"] = translator.IsConfigured;
        ViewData["AiModel"] = translator.Model;
        return View(page);
    }

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> AnalyzePage(int id, CancellationToken cancellationToken)
    {
        if (!translator.IsConfigured) return StatusCode(503, new { error = translator.KeyError });
        var page = await db.Pages.Include(p => p.Chapter).ThenInclude(c => c.Comic).ThenInclude(c => c.ContextEntries)
            .FirstOrDefaultAsync(p => p.Id == id, cancellationToken);
        if (page is null) return NotFound();
        var previousDraft = await db.Pages.Where(p => p.ChapterId == page.ChapterId && p.Number < page.Number)
            .OrderByDescending(p => p.Number).Select(p => p.DraftJson).FirstOrDefaultAsync(cancellationToken);
        string? priorPageText = null;
        if (!string.IsNullOrWhiteSpace(previousDraft))
        {
            try
            {
                using var prior = JsonDocument.Parse(previousDraft);
                priorPageText = string.Join("\n", prior.RootElement.GetProperty("bubbles").EnumerateArray()
                    .Select(b => b.TryGetProperty("translation", out var translated) ? translated.GetString() : null)
                    .Where(s => !string.IsNullOrWhiteSpace(s))).Trim();
                if (priorPageText.Length > 3000) priorPageText = priorPageText[..3000];
            }
            catch (JsonException) { /* An old draft may have a different shape. */ }
            catch (KeyNotFoundException) { /* An old draft may have no bubbles. */ }
        }
        try
        {
            var path = Path.Combine(PageDirectory, page.StorageName);
            var result = await translator.AnalyzeAsync(page.Chapter.Comic, page.Chapter, page, path, priorPageText, cancellationToken);
            var comic = page.Chapter.Comic;
            foreach (var note in result.ContextNotes)
            {
                if (comic.ContextEntries.Count >= 300) break;
                if (comic.ContextEntries.Any(existing => existing.Kind == note.Kind &&
                    string.Equals(existing.Term.Trim(), note.Term.Trim(), StringComparison.OrdinalIgnoreCase))) continue;
                var entry = new ContextEntry
                {
                    ComicId = comic.Id, Kind = note.Kind, Term = note.Term.Trim(),
                    Translation = note.Translation.Trim(),
                    Notes = $"AI from chapter {page.Chapter.Number}, page {page.Number}: {note.Notes.Trim()}"
                };
                comic.ContextEntries.Add(entry);
                db.ContextEntries.Add(entry);
            }
            await db.SaveChangesAsync(cancellationToken);
            return Json(result);
        }
        catch (AiTranslationException ex) { return BadRequest(new { error = ex.Message }); }
        catch (HttpRequestException) { return StatusCode(502, new { error = "Could not reach OpenAI. Try again later." }); }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { return StatusCode(504, new { error = "OpenAI took too long to respond." }); }
        catch (JsonException) { return StatusCode(502, new { error = "OpenAI returned a response the app could not parse." }); }
    }

    [HttpPost, ValidateAntiForgeryToken]
    public async Task<IActionResult> SaveDraft(int id, [FromBody] JsonElement draft)
    {
        var page = await db.Pages.FindAsync(id);
        if (page is null) return NotFound();
        if (draft.ValueKind != JsonValueKind.Object || !draft.TryGetProperty("version", out var version) || version.GetInt32() != 1 || !draft.TryGetProperty("bubbles", out var bubbles) || bubbles.ValueKind != JsonValueKind.Array || bubbles.GetArrayLength() > 500)
            return BadRequest("Invalid draft.");
        var json = draft.GetRawText();
        if (json.Length > 1_000_000) return BadRequest("Draft is too large.");
        page.DraftJson = json; await db.SaveChangesAsync();
        return Ok(new { saved = true });
    }
}
