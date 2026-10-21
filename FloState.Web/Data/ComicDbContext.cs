using FloState.Web.Models;
using Microsoft.EntityFrameworkCore;

namespace FloState.Web.Data;

public sealed class ComicDbContext(DbContextOptions<ComicDbContext> options) : DbContext(options)
{
    public DbSet<Comic> Comics => Set<Comic>();
    public DbSet<Chapter> Chapters => Set<Chapter>();
    public DbSet<ComicPage> Pages => Set<ComicPage>();
    public DbSet<ContextEntry> ContextEntries => Set<ContextEntry>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Comic>().HasMany(c => c.Chapters).WithOne(c => c.Comic).HasForeignKey(c => c.ComicId).OnDelete(DeleteBehavior.Cascade);
        modelBuilder.Entity<Comic>().HasMany(c => c.ContextEntries).WithOne(e => e.Comic).HasForeignKey(e => e.ComicId).OnDelete(DeleteBehavior.Cascade);
        modelBuilder.Entity<Chapter>().HasMany(c => c.Pages).WithOne(p => p.Chapter).HasForeignKey(p => p.ChapterId).OnDelete(DeleteBehavior.Cascade);
        modelBuilder.Entity<Chapter>().HasIndex(c => new { c.ComicId, c.Number }).IsUnique();
        modelBuilder.Entity<ComicPage>().HasIndex(p => new { p.ChapterId, p.Number }).IsUnique();
    }
}
