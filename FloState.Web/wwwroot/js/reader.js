(() => {
  const pages = [...document.querySelectorAll('.reader-page')];
  const queue = [];
  let active = null;
  let mode = 'translated';

  function show(page) {
    const image = page.querySelector('.reader-image');
    image.src = mode === 'translated' && page.dataset.translatedUrl
      ? page.dataset.translatedUrl
      : page.dataset.originalUrl;
  }

  document.querySelectorAll('[data-reader-mode]').forEach(button => {
    button.addEventListener('click', () => {
      mode = button.dataset.readerMode;

      document.querySelectorAll('[data-reader-mode]').forEach(toggle => {
        const selected = toggle === button;
        toggle.classList.toggle('active', selected);
        toggle.setAttribute('aria-pressed', String(selected));
      });

      pages.forEach(show);
    });
  });

  function finish(error) {
    if (!active) {
      return;
    }

    clearTimeout(active.timeout);
    const { page, frame } = active;
    frame.remove();

    if (error) {
      page.querySelector('.reader-page-status').textContent = 'Preview unavailable · showing original';
    }

    active = null;
    pump();
  }

  function pump() {
    if (active || queue.length === 0) {
      return;
    }

    const page = queue.shift();
    const frame = document.createElement('iframe');
    frame.title = `Rendering ${page.querySelector('.reader-page-top span').textContent}`;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.className = 'reader-render-frame';
    frame.src = page.dataset.editUrl;
    document.body.append(frame);

    page.querySelector('.reader-page-status').textContent = 'Rendering translation…';
    active = {
      page,
      frame,
      timeout: setTimeout(() => finish(new Error('Render timed out')), 60000)
    };
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin ||
        event.data?.type !== 'flostate-reader-ready' ||
        !active ||
        event.source !== active.frame.contentWindow) {
      return;
    }

    const canvas = active.frame.contentDocument?.getElementById('pageCanvas');
    if (!canvas?.width || !canvas.height) {
      finish(new Error('Rendered page missing'));
      return;
    }

    const page = active.page;
    canvas.toBlob(blob => {
      if (!active || active.page !== page) {
        return;
      }

      if (!blob) {
        finish(new Error('Could not create preview'));
        return;
      }

      page.dataset.translatedUrl = URL.createObjectURL(blob);
      page.querySelector('.reader-page-status').textContent = 'Translated';
      show(page);
      finish();
    }, 'image/png');
  });

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }

      observer.unobserve(entry.target);
      queue.push(entry.target);
    }

    pump();
  }, { rootMargin: '900px 0px' });

  pages.filter(page => page.dataset.hasDraft === 'true').forEach(page => observer.observe(page));

  window.addEventListener('pagehide', () => {
    pages.forEach(page => {
      if (page.dataset.translatedUrl) {
        URL.revokeObjectURL(page.dataset.translatedUrl);
      }
    });
  });
})();
