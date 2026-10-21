(() => {
  const root = document.getElementById('comic-details');
  if (!root) {
    return;
  }
  const token = document.querySelector('input[name="__RequestVerificationToken"]')?.value;
  const natural = new Intl.Collator(undefined, {numeric:true, sensitivity:'base'});

  document.querySelectorAll('.upload-form').forEach(form => {
    const input = form.querySelector('input[type="file"]');
    const order = form.querySelector('.file-order');
    input.addEventListener('change', () => {
      const files = [...input.files].sort((a,b) => natural.compare(a.name,b.name));
      if (!files.length) {
        order.textContent = 'No images selected.';
        return;
      }
      order.textContent = `${files.length} ${files.length === 1 ? 'page' : 'pages'} in order: ${files.slice(0,5).map(file => file.name).join(' → ')}${files.length > 5 ? ` → … → ${files.at(-1).name}` : ''}`;
    });
    form.addEventListener('submit', event => {
      const files = [...input.files];
      if (files.length < 1 ||
          files.length > 50 ||
          files.some(file => file.size < 1 || file.size > 20_000_000) ||
          files.reduce((total, file) => total + file.size, 0) > 190_000_000) {
        event.preventDefault();
        order.textContent = 'Choose 1–50 images, each under 20 MB, with a total under 190 MB.';
      }
    });
  });

  let researchReceipt = null;
  document.getElementById('research-comic')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const status = document.getElementById('research-status');
    if (!token) {
      status.textContent = 'Security token missing. Reload this page.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Searching for source material…';
    document.getElementById('research-result').hidden = true;
    researchReceipt = null;
    try {
      const response = await fetch(button.dataset.url, {method:'POST',headers:{RequestVerificationToken:token}});
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || `Research returned ${response.status}`);
      }
      document.getElementById('research-summary').textContent = result.summary;
      const sources = document.getElementById('research-sources');
      sources.replaceChildren();
      for (const source of result.sources || []) {
        const link = document.createElement('a');
        link.href = source.url;
        link.textContent = source.title || source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        sources.append(link, document.createElement('br'));
      }
      researchReceipt = result.receipt;
      document.getElementById('accept-research').disabled = !researchReceipt;
      document.getElementById('research-result').hidden = false;
      status.textContent = researchReceipt ? 'Check the match and cited pages before adding them to context.' : 'No cited source was returned.';
    } catch (error) {
      status.textContent = `Research failed: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('accept-research')?.addEventListener('click', async event => {
    if (!researchReceipt) {
      return;
    }
    const button = event.currentTarget;
    const status = document.getElementById('research-status');
    button.disabled = true;
    try {
      const body = new URLSearchParams({receipt:researchReceipt});
      const response = await fetch(button.dataset.url, {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',RequestVerificationToken:token},body});
      if (!response.ok) {
        const result = await response.json();
        throw Error(result.error || `Save returned ${response.status}`);
      }
      location.reload();
    } catch (error) {
      status.textContent = `Could not save research: ${error.message}`;
      button.disabled = false;
    }
  });

  document.querySelectorAll('.analyze-chapter').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest('.chapter');
    const status = card.querySelector('.chapter-status');
    const pages = [...card.querySelectorAll('.page-grid a[data-analyze-url]')].filter(page => page.dataset.hasDraft !== 'true');
    if (!pages.length) {
      status.textContent = 'Every page already has a saved draft.';
      return;
    }
    if (!token) {
      status.textContent = 'Security token missing. Reload this page.';
      return;
    }
    const progress = card.querySelector('.chapter-progress');
    const cancel = card.querySelector('.cancel-chapter');
    const controller = new AbortController();
    let stopped = false;
    let completed = 0;
    button.disabled = true;
    cancel.hidden = false;
    progress.hidden = false;
    progress.max = pages.length;
    progress.value = 0;
    const stop = () => {
      stopped = true;
      controller.abort();
    };
    cancel.addEventListener('click', stop, {once:true});
    try {
      for (const page of pages) {
        if (stopped) {
          break;
        }
        status.textContent = `Analyzing ${page.querySelector('.page-title').textContent} · ${completed + 1} of ${pages.length}`;
        const analyzed = await fetch(page.dataset.analyzeUrl, {method:'POST',headers:{RequestVerificationToken:token},signal:controller.signal});
        const result = await analyzed.json();
        if (!analyzed.ok) {
          throw Error(result.error || `Analysis returned ${analyzed.status}`);
        }
        if (!Array.isArray(result.bubbles)) {
          throw Error('The AI result had no bubble list.');
        }
        const dimensions = await new Promise((resolve,reject) => {
          const image = new Image();
          image.onload = () => resolve({width:image.naturalWidth,height:image.naturalHeight});
          image.onerror = () => reject(Error('Could not load the page image.'));
          image.src = page.dataset.imageUrl;
        });
        if (stopped) {
          break;
        }
        const bubbles = result.bubbles.map((bubble,index) => ({
          id:index+1, x:bubble.x/1000*dimensions.width, y:bubble.y/1000*dimensions.height,
          w:bubble.w/1000*dimensions.width, h:bubble.h/1000*dimensions.height,
          shape:bubble.shape, source:bubble.source, translation:bubble.translation, uncertain:bubble.uncertain,
          fill:'#ffffff', color:'#111111', fontSize:160, padding:3, font:bubble.font || 'Comic Sans MS', bold:bubble.bold !== false
        }));
        const saved = await fetch(page.dataset.saveUrl, {method:'POST',headers:{'Content-Type':'application/json',RequestVerificationToken:token},body:JSON.stringify({version:1,bubbles}),signal:controller.signal});
        if (!saved.ok) {
          throw Error(`Saving suggestions returned ${saved.status}`);
        }
        page.dataset.hasDraft = 'true';
        page.querySelector('.page-state').textContent = 'Draft saved';
        completed++;
        progress.value = completed;
      }
      status.textContent = stopped ? `Stopped after ${completed} of ${pages.length} pages.` : `${completed} pages translated and saved. Review them in the editor or reader.`;
    } catch (error) {
      status.textContent = error.name === 'AbortError'
        ? `Stopped after ${completed} pages.`
        : `Stopped after ${completed} pages: ${error.message}`;
    } finally {
      cancel.removeEventListener('click', stop);
      cancel.hidden = true;
      button.disabled = false;
    }
  }));

  if (root.dataset.autoAnalyze) {
    const button = root.querySelector(`.chapter[data-chapter-id="${CSS.escape(root.dataset.autoAnalyze)}"] .analyze-chapter`);
    const url = new URL(location.href);
    url.searchParams.delete('analyzeChapter');
    history.replaceState(null, '', url);
    if (button && !button.disabled) {
      button.click();
    }
  }
})();
