using System.ComponentModel.DataAnnotations;

namespace FloState.Web.Models;

public sealed class Comic
{
    public int Id { get; set; }
    [Required, StringLength(160)] public string Title { get; set; } = "";
    [Required, StringLength(80)] public string SourceLanguage { get; set; } = "";
    [Required, StringLength(80)] public string TargetLanguage { get; set; } = "";
    [StringLength(2000)] public string? Description { get; set; }
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public List<Chapter> Chapters { get; set; } = [];
    public List<ContextEntry> ContextEntries { get; set; } = [];
}

public sealed class Chapter
{
    public int Id { get; set; }
    public int ComicId { get; set; }
    public Comic Comic { get; set; } = null!;
    [Range(1, 100000)] public int Number { get; set; }
    [Required, StringLength(160)] public string Title { get; set; } = "";
    public List<ComicPage> Pages { get; set; } = [];
}

public sealed class ComicPage
{
    public int Id { get; set; }
    public int ChapterId { get; set; }
    public Chapter Chapter { get; set; } = null!;
    public int Number { get; set; }
    [Required, StringLength(255)] public string OriginalFileName { get; set; } = "";
    [Required] public string StorageName { get; set; } = "";
    [Required] public string ContentType { get; set; } = "";
    public string? DraftJson { get; set; }
}

public sealed class ContextEntry
{
    public int Id { get; set; }
    public int ComicId { get; set; }
    public Comic Comic { get; set; } = null!;
    [Required, StringLength(40)] public string Kind { get; set; } = "Character";
    [Required, StringLength(160)] public string Term { get; set; } = "";
    [Required, StringLength(160)] public string Translation { get; set; } = "";
    [StringLength(1000)] public string? Notes { get; set; }
}
