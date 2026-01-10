/**
 * Article HTML Generator for Main Process
 * 
 * Generates article HTML for prefetch in the main process.
 * Used for both RSS/Local and FullContent modes.
 */

export interface ArticleRenderOptions {
    title: string
    date: Date
    content: string
    baseUrl: string
    textDir: 'ltr' | 'rtl' | 'vertical'
    fontSize: number
    fontFamily: string
    locale: string
}

/**
 * Text direction enum values (must match renderer)
 */
export enum TextDirection {
    LTR = 0,
    RTL = 1,
    Vertical = 2
}

/**
 * Convert numeric text direction to string
 */
export function textDirToString(dir: number): 'ltr' | 'rtl' | 'vertical' {
    switch (dir) {
        case TextDirection.RTL: return 'rtl'
        case TextDirection.Vertical: return 'vertical'
        default: return 'ltr'
    }
}

/**
 * Generate article HTML as a data URL
 * This is the Main process equivalent of articleView() in the renderer
 */
export function generateArticleHtml(options: ArticleRenderOptions): string {
    const { title, date, content, baseUrl, textDir, fontSize, fontFamily, locale } = options
    
    // Content analysis for comic/image mode
    const imgCount = (content.match(/<img/gi) || []).length
    const pictureCount = (content.match(/<picture/gi) || []).length
    const totalImages = imgCount + pictureCount
    
    // Extract text without HTML tags
    const textOnly = content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    const textLength = textOnly.length
    
    const isComicMode = totalImages > 0 && textLength < 200
    const isSingleImage = totalImages === 1 && textLength < 100
    
    // Format date
    const dateStr = date.toLocaleString(locale, { 
        hour12: !locale.startsWith("zh") 
    })
    
    // Generate header HTML
    const headerHtml = `
        <p class="title">${escapeHtml(title)}</p>
        <p class="date">${escapeHtml(dateStr)}</p>
    `
    
    const rtlClass = textDir === 'rtl' ? 'rtl' : textDir === 'vertical' ? 'vertical' : ''
    const comicClass = isComicMode ? 'comic-mode' : ''
    const singleImageClass = isSingleImage ? 'single-image' : ''
    
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; img-src http: https: data:; style-src 'unsafe-inline'; frame-src http: https:; media-src http: https:; connect-src https: http:">
    <title>Article</title>
    <style>
/* Scrollbar Styles */
::-webkit-scrollbar { width: 16px; }
::-webkit-scrollbar-thumb { border: 2px solid transparent; background-color: #0004; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: #0006; }
::-webkit-scrollbar-thumb:active { background-color: #0008; }

/* CSS Variables */
:root { --gray: #484644; --primary: #0078d4; --primary-alt: #004578; }

/* Base Styles */
html, body { margin: 0; padding: 0; font-family: "Segoe UI", "Source Han Sans Regular", sans-serif; }
body { padding: 8px; overflow-x: hidden; overflow-y: auto; font-size: ${fontSize}px; box-sizing: border-box; width: 100%; }
${fontFamily ? `body { font-family: "${fontFamily}"; }` : ''}
body.rtl { direction: rtl; }
body.vertical { writing-mode: vertical-rl; padding: 8px; padding-right: 96px; overflow: scroll hidden; }
* { box-sizing: border-box; }

/* Typography */
h1, h2, h3, h4, h5, h6, b, strong { font-weight: 600; }
a { color: var(--primary); text-decoration: none; }
a:hover, a:active { color: var(--primary-alt); text-decoration: underline; }

/* Main Container */
#main { display: none; width: 100%; margin: 0; max-width: 100%; margin: 0 auto; }
body.vertical #main { max-width: unset; max-height: 100%; margin: auto 0; }
#main.show { display: block; animation-name: fadeIn; animation-duration: 0.367s; animation-timing-function: cubic-bezier(0.1, 0.9, 0.2, 1); animation-fill-mode: both; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

/* Title and Date */
#main > p.title { font-size: 1.25rem; line-height: 1.75rem; font-weight: 600; margin-block-end: 0; }
#main > p.date { color: var(--gray); font-size: 0.875rem; margin-block-start: 0.5rem; }

/* Article Content */
#main > article { max-width: 1024px; margin: 8px auto 0; padding: 0 8px; }
article { line-height: 1.6; }
body.vertical article { line-height: 1.5; }
body.vertical article p { text-indent: 2rem; }
article * { max-width: 100%; }
article img { height: auto; max-width: 100%; }
body.vertical article img { max-height: 75%; }
article figure { margin: 16px 0; text-align: center; }
article figure figcaption { font-size: 0.875rem; color: var(--gray); -webkit-user-modify: read-only; }
article iframe { width: 100%; }
article code { font-family: Monaco, Consolas, monospace; font-size: 0.875rem; line-height: 1; word-break: break-word; }
article pre { word-break: normal; overflow-wrap: normal; white-space: pre-wrap; max-width: 100%; overflow-x: auto; }
article blockquote { border-left: 2px solid var(--gray); margin: 1em 0; padding: 0 40px; }
#main table { max-width: 100%; overflow-x: auto; }

/* Dark Mode */
@media (prefers-color-scheme: dark) {
  :root { --gray: #a19f9d; --primary: #4ba0e1; --primary-alt: #65aee6; }
  body { background-color: #2d2d30; color: #f8f8f8; }
  #main > p.date { color: #a19f9d; }
  a { color: #4ba0e1; }
  a:hover, a:active { color: #65aee6; }
  ::-webkit-scrollbar-thumb { background-color: #fff4; }
  ::-webkit-scrollbar-thumb:hover { background-color: #fff6; }
  ::-webkit-scrollbar-thumb:active { background-color: #fff8; }
}

/* Comic Mode Styles */
.comic-mode #main { max-width: 100%; padding: 0; }
.comic-mode article img, .comic-mode #main > img { max-width: 100%; width: 100%; height: auto; display: block; margin: 0 auto; }
.comic-mode .title, .comic-mode .date { text-align: center; padding: 0 8px; }
.comic-mode p { text-align: center; }

/* Single Image Mode */
.single-image #main { max-width: 100%; display: flex; flex-direction: column; align-items: center; padding: 0; }
.single-image article img, .single-image #main > img { max-height: 90vh; width: auto; max-width: 100%; object-fit: contain; }
    </style>
</head>
<body class="${rtlClass} ${comicClass} ${singleImageClass}">
    <div id="main"></div>
    <script>
window.__articleData = ${JSON.stringify({ 
    header: headerHtml, 
    article: content, 
    baseUrl: baseUrl 
}).replace(/<\/script>/gi, '<\\/script>')};

(function() {
    const { header, article, baseUrl } = window.__articleData;
    let domParser = new DOMParser();
    let headerDom = domParser.parseFromString(header, 'text/html');
    let main = document.getElementById("main");
    main.innerHTML = headerDom.body.innerHTML + article;
    
    let baseEl = document.createElement('base');
    baseEl.setAttribute('href', baseUrl.split("/").slice(0, 3).join("/"));
    document.head.append(baseEl);
    
    for (let s of main.querySelectorAll("script")) { s.parentNode.removeChild(s); }
    for (let e of main.querySelectorAll("*[src]")) { e.src = e.src; }
    for (let e of main.querySelectorAll("*[href]")) { e.href = e.href; }
    
    if (document.body.classList.contains('comic-mode') || document.body.classList.contains('single-image')) {
        main.querySelectorAll('p > img').forEach(img => {
            const p = img.parentElement;
            const textContent = p.textContent.trim();
            const hasOnlyImage = p.children.length === 1 && textContent === '';
            if (hasOnlyImage) { p.replaceWith(img); }
        });
    }
    
    if (document.body.classList.contains('comic-mode')) {
        const firstImg = main.querySelector('img');
        if (firstImg) {
            firstImg.id = 'comic-image';
            setTimeout(() => { firstImg.scrollIntoView({ behavior: 'instant', block: 'start' }); }, 100);
        }
    }
    
    main.classList.add("show");
})();
    </script>
</body>
</html>`

    // Convert to base64 data URL
    return `data:text/html;base64,${Buffer.from(htmlContent, 'utf-8').toString('base64')}`
}

/**
 * Generate FullContent article HTML with extracted content
 * Wraps extracted content in semantic article structure
 */
export function generateFullContentHtml(options: ArticleRenderOptions & { 
    extractorTitle?: string
    extractorDate?: Date 
}): string {
    const { title, date, content, baseUrl, textDir, fontSize, fontFamily, locale } = options
    const extractorTitle = options.extractorTitle || title
    const extractorDate = options.extractorDate || date
    
    // Format date for header
    const dateStr = extractorDate.toLocaleDateString(locale, { 
        year: "numeric", 
        month: "long", 
        day: "numeric" 
    })
    
    // Wrap in semantic article structure (matching renderer's loadFull)
    const headerHtml = extractorTitle ? `
        <header>
            <h1>${escapeHtml(extractorTitle)}</h1>
            ${dateStr ? `<p><time datetime="${extractorDate.toISOString()}">${dateStr}</time></p>` : ""}
        </header>
    ` : ""
    
    const footerHtml = `
        <footer>
            <p>Quelle: <a href="${escapeHtml(baseUrl)}" target="_blank">${escapeHtml(new URL(baseUrl).hostname)}</a></p>
        </footer>
    `
    
    const wrappedContent = `
        <article>
            ${headerHtml}
            <section>${content}</section>
            ${footerHtml}
        </article>
    `
    
    // Use the base generator with wrapped content
    // For FullContent, don't show duplicate title/date in main header
    return generateArticleHtml({
        ...options,
        title: '',  // Don't show in main header (already in article header)
        content: wrappedContent
    })
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}
