using System.Net;
using System.Text;
using System.Text.Json;
using FloState.Web.Models;
using FloState.Web.Services;
using Microsoft.Extensions.Configuration;

var imagePath = Path.GetTempFileName();
try
{
    await File.WriteAllBytesAsync(imagePath, [137, 80, 78, 71, 13, 10, 26, 10]);
    var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["OpenAI:ApiKey"] = "sk-proj-test-key-12345678901234567890",
        ["OpenAI:Model"] = "gpt-6-luna"
    }).Build();
    var invalidConfig = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["OpenAI:ApiKey"] = "x" }).Build();
    var invalidTranslator = new OpenAiComicTranslator(new HttpClient(new FakeHandler()), invalidConfig);
    if (invalidTranslator.IsConfigured || !invalidTranslator.KeyError.Contains("incomplete"))
        throw new Exception("Incomplete API key was accepted.");
    using var client = new HttpClient(new FakeHandler());
    var translator = new OpenAiComicTranslator(client, config);
    var comic = new Comic { Title = "Sample", SourceLanguage = "Japanese", TargetLanguage = "English", Description = "Warm humor" };
    comic.ContextEntries.Add(new ContextEntry { Kind = "Nickname", Term = "Neko", Translation = "Kitty", Notes = "Use for the cat" });
    var chapter = new Chapter { Number = 1, Title = "Opening", Comic = comic };
    var page = new ComicPage { Number = 1, ContentType = "image/png" };
    var result = await translator.AnalyzeAsync(comic, chapter, page, imagePath, "Previous dialogue", CancellationToken.None);
    if (result.Bubbles.Count != 1 || result.Bubbles[0].Translation != "Hello!" || result.Bubbles[0].X != 100 || result.Bubbles[0].Shape != "ellipse" || result.ContextNotes.Single().Term != "Neko")
        throw new Exception("Structured bubble parsing failed.");
    using var fallbackClient = new HttpClient(new DetailFallbackHandler());
    var fallbackResult = await new OpenAiComicTranslator(fallbackClient, config).AnalyzeAsync(comic, chapter, page, imagePath, null, CancellationToken.None);
    if (fallbackResult.Bubbles.Count != 1) throw new Exception("Image detail fallback failed.");
    using var researchClient = new HttpClient(new ResearchHandler());
    var research = await new OpenAiComicTranslator(researchClient, config).ResearchAsync(comic, CancellationToken.None);
    if (!research.Summary.Contains("The source work") || research.Sources.Single().Url != "https://example.org/work")
        throw new Exception("Research citation parsing failed.");
    using var badClient = new HttpClient(new BadRequestHandler());
    try
    {
        await new OpenAiComicTranslator(badClient, config).AnalyzeAsync(comic, chapter, page, imagePath, null, CancellationToken.None);
        throw new Exception("Expected a 400 diagnostic.");
    }
    catch (AiTranslationException ex)
    {
        if (!ex.Message.Contains("invalid_json_schema") || ex.Message.Contains("sk-testsecret"))
            throw new Exception("The API error was not reported safely.");
    }
    Console.WriteLine("OpenAI request and response smoke test passed.");
}
finally { File.Delete(imagePath); }

sealed class DetailFallbackHandler : HttpMessageHandler
{
    private int calls;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
        var detail = body.RootElement.GetProperty("input")[1].GetProperty("content")[1].GetProperty("detail").GetString();
        if (++calls == 1 && detail == "original")
            return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("{\"error\":{\"code\":\"invalid_image\",\"param\":\"input[1].content[1].detail\",\"message\":\"Image patch limit exceeded\"}}") };
        if (calls != 2 || detail != "high") throw new Exception("The image detail retry was not made correctly.");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"status\":\"completed\",\"output\":[{\"content\":[{\"type\":\"output_text\",\"text\":\"{\\\"bubbles\\\":[{\\\"source\\\":\\\"Hi\\\",\\\"translation\\\":\\\"Hello!\\\",\\\"shape\\\":\\\"ellipse\\\",\\\"x\\\":100,\\\"y\\\":200,\\\"w\\\":300,\\\"h\\\":100,\\\"uncertain\\\":false}]}\"}]}]}") };
    }
}

sealed class BadRequestHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("{\"error\":{\"code\":\"invalid_json_schema\",\"param\":\"text.format.schema\",\"message\":\"Bad schema near sk-testsecret\"}}")
        });
}

sealed class ResearchHandler : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
        if (body.RootElement.GetProperty("tools")[0].GetProperty("type").GetString() != "web_search")
            throw new Exception("Research did not request web search.");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"status\":\"completed\",\"output\":[{\"content\":[{\"type\":\"output_text\",\"text\":\"The source work has a nickname.\",\"annotations\":[{\"type\":\"url_citation\",\"url\":\"https://example.org/work\",\"title\":\"Example Wiki\"}]}]}]}") };
    }
}

sealed class FakeHandler : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri?.AbsoluteUri != "https://api.openai.com/v1/responses" || request.Headers.Authorization?.Parameter != "sk-proj-test-key-12345678901234567890")
            throw new Exception("OpenAI request destination or authorization is wrong.");
        using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
        var root = body.RootElement;
        if (root.GetProperty("model").GetString() != "gpt-6-luna" || root.GetProperty("store").GetBoolean() ||
            root.GetProperty("text").GetProperty("format").GetProperty("strict").GetBoolean() != true)
            throw new Exception("OpenAI request settings are wrong.");
        var user = root.GetProperty("input")[1].GetProperty("content");
        if (!user[0].GetProperty("text").GetString()!.Contains("Neko") ||
            !user[0].GetProperty("text").GetString()!.Contains("Previous dialogue") ||
            user[1].GetProperty("detail").GetString() != "original")
            throw new Exception("Comic context or image detail is missing.");
        var output = JsonSerializer.Serialize(new { bubbles = new[] { new { source = "こんにちは", translation = "Hello!", shape = "ellipse", x = 100, y = 200, w = 300, h = 100, uncertain = false } }, contextNotes = new[] { new { kind = "Nickname", term = "Neko", translation = "Kitty", notes = "The character uses this nickname." } } });
        var response = JsonSerializer.Serialize(new { status = "completed", output = new[] { new { content = new[] { new { type = "output_text", text = output } } } } });
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(response, Encoding.UTF8, "application/json") };
    }
}
