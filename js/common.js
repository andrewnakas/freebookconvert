// Shared dropzone + UI helpers used by every converter page.
(function (global) {
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function bindDropzone(dropzoneEl, fileInputEl, onFiles, accept) {
    dropzoneEl.addEventListener('click', function () { fileInputEl.click(); });
    fileInputEl.addEventListener('change', function (e) {
      onFiles(Array.from(e.target.files));
      fileInputEl.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropzoneEl.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzoneEl.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.remove('dragover');
      });
    });
    dropzoneEl.addEventListener('drop', function (e) {
      var files = Array.from(e.dataTransfer.files);
      if (accept) {
        files = files.filter(function (f) {
          return accept.some(function (ext) {
            return f.name.toLowerCase().endsWith(ext);
          });
        });
      }
      onFiles(files);
    });
  }

  function setStatus(el, kind, msg) {
    el.className = 'status ' + kind;
    el.textContent = msg;
  }

  function clearStatus(el) {
    el.className = 'status hidden';
    el.textContent = '';
  }

  function setProgress(barEl, pct) {
    barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function renderFileList(listEl, files, onRemove) {
    listEl.innerHTML = '';
    files.forEach(function (f, idx) {
      var item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = '<span><span class="name"></span><span class="size"></span></span>';
      item.querySelector('.name').textContent = f.name;
      item.querySelector('.size').textContent = fmtBytes(f.size);
      var rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.onclick = function () { onRemove(idx); };
      item.appendChild(rm);
      listEl.appendChild(item);
    });
  }

  global.CV = {
    $: $, $$: $$,
    fmtBytes: fmtBytes,
    bindDropzone: bindDropzone,
    setStatus: setStatus,
    clearStatus: clearStatus,
    setProgress: setProgress,
    downloadBlob: downloadBlob,
    renderFileList: renderFileList
  };
})(window);
