# FloState Studio

An ASP.NET Core MVC prototype for translating comic pages while preserving the original artwork outside edited bubble regions.

## Run locally

```powershell
dotnet run --project FloState.Web/FloState.Web.csproj
```

Open the local URL printed by `dotnet run`. Create a comic and chapter, then select up to 50 page images at once (20 MB per image, 190 MB total). Uploads are stored in natural filename order, so `page-2.png` precedes `page-10.png`. **Upload & translate** analyzes the unsaved pages in order after the upload; **Upload only** saves the images for later. The chapter progress display shows each page and lets you stop after the current request. Existing saved drafts are skipped. Each page also opens in an editor for review and PNG export. The standalone editor is available at `/Home`.

**Read all chapters** opens a continuous, ordered view of every chapter. Saved translations render on demand as you scroll. Pages without a saved draft show their original image. The reader can switch between translated and original pages.

The dark theme uses Tailwind CSS compiled locally, with additional styles for the canvas editor. The compiled stylesheet is included in the repository so a normal `dotnet run` needs no Node process. After changing Tailwind classes or the source file, rebuild the stylesheet with:

```powershell
npm install
npm run css:build
```

## Current storage

- SQLite stores comics, chapters, page order, context entries, and page lettering drafts in `FloState.Web/App_Data/flostate.db`.
- Original page images are stored as randomly named files in `FloState.Web/App_Data/pages`. They are served by a controller action, not from `wwwroot`.
- The browser holds the editable preview and renders the export from the original image each time. Pixels outside marked rectangles are never repainted.
- `App_Data` is ignored by Git. Back up this directory to preserve projects and source images.

This prototype creates its schema automatically on first run. Before a production release, replace `EnsureCreated` with versioned EF Core migrations, add user accounts and authorization, and move file storage behind a storage service if hosting across multiple servers. Do not expose this version on a public network: it has no sign-in or access control.

## OpenAI setup

The page editor uses OpenAI's Responses API, with `gpt-6-luna` as the default. To configure a key locally, run this **one command** in PowerShell from the repository root:

```powershell
.\scripts\Set-OpenAiKey.ps1
```

Wait for the key prompt, paste the complete key, and press Enter. The script will not save an incomplete value. Restart the app afterward. The **AI settings** page shows whether a key is configured, but never displays its value. This command keeps the key out of PowerShell command history and the repository. .NET User Secrets are stored in your operating-system profile and are **not encrypted**; they are for local development. When hosted, inject `OpenAI__ApiKey` from your hosting platform's secret manager. `OPENAI_API_KEY` is also supported. Do not enter the key into `appsettings.json`, browser code, or the SQLite database.

You can change `OpenAI:Model` in `FloState.Web/appsettings.json`. The current request uses structured JSON output and original image detail; verify those capabilities for a different model before switching.

## AI page workflow

Open a stored page and click **Analyze with AI**. The server sends the original page, comic title and description, source and target languages, chapter name, glossary entries, and any saved dialogue from the preceding page. It asks for source text, translation, reading order, and approximate inner bubble rectangles in normalized image coordinates. The request sets `store: false` so it does not create a stored Responses API conversation; other OpenAI data handling policies still apply.

The same analysis asks for durable context grounded in the page, such as character names, nicknames, recurring terms, and style notes. New notes are saved automatically to the comic and sent with later pages. Duplicate terms are skipped so the AI does not overwrite an existing preference. The context form remains available for corrections.

**Research with AI** on the comic page makes a separate OpenAI web search request for possible source material. It displays the summary and cited pages. Check that the work really matches, then click **Use this context** to save the research summary for later translations. The button is disabled when no cited source is returned. Web search incurs additional tool and token charges.

The suggestions appear in the editor. The renderer first cleans the original lettering, then lays out translated text separately. **Fit inside detected bubble** chooses a text rectangle using the translation's actual font fit. For connected white balloons, it reserves the lower balloon's nearby area before laying out the upper one. When a rectangle wastes substantial space, it can fit separate lines to the available white width at each height. Automatic lettering is clipped to the detected bubble interior, so an inaccurate proposal cannot paint text across neighboring artwork. The blue outline shows the effective text area. Dragging it switches that bubble to manual placement, and the **Text placement** selector can switch modes directly. **Preview whiteout only** shows the cleanup stage. Automatic cleanup follows connected white bubble interiors; for letters it misses, select a bubble and use **Brush remaining letters**. **Edit whiteout area** switches to a separately movable manual whiteout shape. Use **Undo brush stroke** if a stroke crosses artwork. The font size is a maximum: the editor chooses the largest size that fits the available area and warns when even the minimum will not fit. Review each page, then click **Save page**. Analysis does not overwrite a saved draft until you save it. The preview uses the same browser canvas as the PNG export.

New bubbles default to bold Comic Sans MS lettering. AI analysis suggests boldness and the closest font from the editor's four available choices for each region; it does not identify an exact typeface. Both settings can be changed per bubble before export.

**Match original bubble color** is the default paint mode. Rounded speech bubbles use the stricter white-interior detector. Rectangular caption boxes can sample a light tinted interior by row, preserving simple color gradients while removing old lettering. **Use selected color** applies the color picker instead. The brush also uses the sampled row color in automatic mode. Existing drafts retain their saved font and boldness; the new lettering defaults apply to new bubbles and AI analyses. Review textured or dark backgrounds manually.

From the comic page, **Translate remaining pages** works through a chapter in page order and saves each page's suggestions. **Upload & translate** starts the same process after a batch upload. Existing drafts are skipped. The next page receives the previous page's saved translations as context. Each page is a separate API request and incurs its own cost. If a page fails or you stop the batch, earlier saved results remain; review each page in the editor before exporting.

On HTTP 400, the app tries `high` image detail after `original`. If both fail, it displays OpenAI's error details when available and a request ID for troubleshooting. Original images over 15 MB cannot be sent in a single AI request in this version. The rendering code supports oval and rectangular fills within solid-color bubble interiors. Irregular masks, textured background repair, and batch export remain future work.

The mocked request/response check runs without a key or network access:

```powershell
dotnet run --project tests/FloState.Smoke/FloState.Smoke.csproj
```
