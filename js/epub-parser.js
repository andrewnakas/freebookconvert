// Minimal EPUB parser. Returns an ordered list of chapters plus metadata.
// Uses JSZip (loaded via CDN on each page).
(function (global) {
  async function parseEpub(file) {
    var zip = await JSZip.loadAsync(file);

    var containerXml = await readText(zip, 'META-INF/container.xml');
    if (!containerXml) throw new Error('Not a valid EPUB (no container.xml).');

    var opfPath = extractOpfPath(containerXml);
    if (!opfPath) throw new Error('Could not find OPF file inside EPUB.');

    var opfXml = await readText(zip, opfPath);
    if (!opfXml) throw new Error('Could not read OPF file: ' + opfPath);

    var opfDir = opfPath.split('/').slice(0, -1).join('/');
    var opf = parseOpf(opfXml, opfDir);

    var chapters = [];
    for (var i = 0; i < opf.spine.length; i++) {
      var entry = opf.spine[i];
      var html = await readText(zip, entry.href);
      if (html) {
        chapters.push({
          id: entry.id,
          href: entry.href,
          title: extractTitle(html) || entry.id,
          html: html
        });
      }
    }

    var images = {};
    var manifestItems = opf.manifest;
    for (var key in manifestItems) {
      var item = manifestItems[key];
      if (item.mediaType && item.mediaType.indexOf('image/') === 0) {
        try {
          var blob = await zip.file(item.href).async('blob');
          images[item.href] = blob;
        } catch (e) { /* skip missing */ }
      }
    }

    return {
      title: opf.title,
      author: opf.author,
      language: opf.language,
      chapters: chapters,
      images: images,
      opfDir: opfDir
    };
  }

  async function readText(zip, path) {
    var f = zip.file(path);
    if (!f) {
      // try lowercase variations
      var match = Object.keys(zip.files).find(function (k) { return k.toLowerCase() === path.toLowerCase(); });
      if (match) f = zip.file(match);
    }
    if (!f) return null;
    return await f.async('string');
  }

  function extractOpfPath(containerXml) {
    var m = containerXml.match(/<rootfile[^>]*full-path=["']([^"']+)["']/i);
    return m ? m[1] : null;
  }

  function parseOpf(opfXml, opfDir) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(opfXml, 'application/xml');

    var title = getText(doc, 'title') || 'Untitled';
    var author = getText(doc, 'creator') || 'Unknown';
    var language = getText(doc, 'language') || 'en';

    var manifest = {};
    var items = doc.getElementsByTagName('item');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var id = it.getAttribute('id');
      var href = it.getAttribute('href');
      var mt = it.getAttribute('media-type');
      if (id && href) {
        manifest[id] = {
          id: id,
          href: opfDir ? (opfDir + '/' + href) : href,
          mediaType: mt
        };
      }
    }

    var spine = [];
    var spineEl = doc.getElementsByTagName('spine')[0];
    if (spineEl) {
      var itemRefs = spineEl.getElementsByTagName('itemref');
      for (var j = 0; j < itemRefs.length; j++) {
        var idref = itemRefs[j].getAttribute('idref');
        if (manifest[idref]) spine.push(manifest[idref]);
      }
    }

    return { title: title, author: author, language: language, manifest: manifest, spine: spine };
  }

  function getText(doc, tag) {
    var els = doc.getElementsByTagName(tag);
    for (var i = 0; i < els.length; i++) {
      if (els[i].textContent && els[i].textContent.trim()) return els[i].textContent.trim();
    }
    var nsTags = doc.getElementsByTagNameNS('*', tag);
    for (var j = 0; j < nsTags.length; j++) {
      if (nsTags[j].textContent && nsTags[j].textContent.trim()) return nsTags[j].textContent.trim();
    }
    return null;
  }

  function extractTitle(html) {
    var m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) return m[1].trim();
    var h = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i);
    return h ? h[1].trim() : null;
  }

  function htmlToText(html) {
    var div = document.createElement('div');
    div.innerHTML = html.replace(/<style[\s\S]*?<\/style>/gi, '')
                       .replace(/<script[\s\S]*?<\/script>/gi, '');
    // Insert blank lines between blocks
    var blocks = div.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, br, div');
    blocks.forEach(function (b) {
      if (b.tagName === 'BR') b.replaceWith('\n');
      else b.insertAdjacentText('beforeend', '\n');
    });
    var text = div.textContent || '';
    return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  global.EpubParser = {
    parseEpub: parseEpub,
    htmlToText: htmlToText
  };
})(window);
