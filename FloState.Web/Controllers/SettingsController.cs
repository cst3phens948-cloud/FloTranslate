using FloState.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace FloState.Web.Controllers;

public sealed class SettingsController(OpenAiComicTranslator translator) : Controller
{
    public IActionResult Index() => View(new OpenAiSettingsStatus(translator.KeyStatus, translator.Model));
}

public sealed record OpenAiSettingsStatus(string KeyStatus, string Model);
