const casesEl = document.getElementById("cases");
const caseCountEl = document.getElementById("caseCount");
const selectedCountEl = document.getElementById("selectedCount");
const sourceValueEl = document.getElementById("sourceValue");
const downloadCsvBtn = document.getElementById("downloadCsv");
const warningEl = document.getElementById("warning");
const viewerEl = document.getElementById("viewer");
const viewerImageEl = document.getElementById("viewerImage");
const viewerCloseEl = document.getElementById("viewerClose");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomResetBtn = document.getElementById("zoomReset");
const startScreenEl = document.getElementById("startScreen");
const loadingStatusEl = document.getElementById("loadingStatus");
const loadingTextEl = document.getElementById("loadingText");
const startButtons = Array.from(startScreenEl.querySelectorAll("[data-folder]"));

const caseTemplate = document.getElementById("caseTemplate");
const segTemplate = document.getElementById("segTemplate");

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "bmp",
  "gif",
  "webp",
]);
const ORIGINAL_SUFFIXES = ["-images", "-image"];
const SEGMENTATION_LABELS = new Map([
  ["-gt", "Ground truth"],
  ["-argmax", "Argmax"],
]);
const DEFAULT_MANIFEST = "manifest.json";
const THRESHOLD_SUFFIX_PATTERN = /-thr(\d+)$/;

let selections = new Map();
let currentUrls = [];
let failedImages = [];
let lastWarnings = [];
let failedPreviewSample = [];
let fetchErrors = [];
let activeFolder = "";
let viewerScale = 1;

const setLoadingState = (isLoading, text = "") => {
  if (loadingStatusEl) loadingStatusEl.hidden = !isLoading;
  if (loadingTextEl && text) loadingTextEl.textContent = text;
  startButtons.forEach((btn) => {
    btn.disabled = isLoading;
  });
};

const setSourceValue = (label) => {
  if (sourceValueEl) sourceValueEl.textContent = label;
};

const revokeUrls = () => {
  currentUrls.forEach((url) => URL.revokeObjectURL(url));
  currentUrls = [];
};

const closeViewer = () => {
  viewerEl.hidden = true;
  viewerImageEl.src = "";
  document.body.style.overflow = "";
};

const openViewer = (src, altText = "Preview") => {
  viewerScale = 1;
  viewerImageEl.style.transform = `scale(${viewerScale})`;
  viewerImageEl.src = src;
  viewerImageEl.alt = altText;
  viewerEl.hidden = false;
  document.body.style.overflow = "hidden";
};

const attachImage = (imgEl, file, fallbackEl, altText) => {
  imgEl.alt = altText;
  fallbackEl.hidden = true;
  const name = file.name || file.src || file.url || "unknown";

  const showFallback = () => {
    // Keep UI clean; surface issues via warnings instead of per-image text.
    fallbackEl.hidden = true;
    failedImages.push(name);
    if (failedPreviewSample.length < 3) failedPreviewSample.push(name);
    console.warn("Image failed to load:", name);
    setWarning(lastWarnings);
  };

  const bindViewer = () => {
    if (!imgEl.dataset.viewerBound) {
      imgEl.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openViewer(imgEl.src, altText);
      });
      imgEl.dataset.viewerBound = "true";
    }
  };

  // Blob-based (File or fetched blob)
  const blob = file instanceof File ? file : file.blob instanceof Blob ? file.blob : null;
  if (blob) {
    console.debug("Loading image via FileReader:", name, blob.type, blob.size);
    const reader = new FileReader();
    reader.onerror = showFallback;
    reader.onload = () => {
      console.debug("FileReader loaded:", name);
      imgEl.onload = () => {
        fallbackEl.hidden = true;
        bindViewer();
      };
      imgEl.onerror = showFallback;
      imgEl.src = reader.result;
    };
    reader.readAsDataURL(blob);
    return;
  }

  // URL-based
  const sourceUrl = file.src || file.url;
  if (!sourceUrl) {
    showFallback();
    return;
  }

  console.debug("Loading image via URL:", name, sourceUrl);
  imgEl.onload = () => {
    fallbackEl.hidden = true;
    bindViewer();
  };
  imgEl.onerror = () => {
    fetch(sourceUrl)
      .then((res) => res.blob())
      .then((fetchedBlob) => {
        const reader = new FileReader();
        reader.onerror = showFallback;
        reader.onload = () => {
          imgEl.onload = () => {
            fallbackEl.hidden = true;
            bindViewer();
          };
          imgEl.onerror = showFallback;
          imgEl.src = reader.result;
        };
        reader.readAsDataURL(fetchedBlob);
      })
      .catch(showFallback);
  };
  imgEl.src = sourceUrl;
};

const extractFilesFromListing = (html, basePath) => {
  const files = [];
  const linkRegex = /href="([^"]+)"/g;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href || href === "../" || href.endsWith("/")) continue;
    const decoded = decodeURIComponent(href);
    const name = decoded.split("/").pop();
    if (!name || !IMAGE_EXTENSIONS.has(getExtension(name))) continue;
    files.push({ name, src: `${basePath}${decoded}` });
  }
  return files;
};

const fetchAsBlobs = async (files, onProgress) => {
  const results = [];
  const errors = [];
  let processed = 0;
  for (const f of files) {
    try {
      const res = await fetch(f.src || f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      results.push({ name: f.name, blob });
    } catch (err) {
      console.warn("Fetch failed:", f.name, err);
      errors.push(f.name);
    } finally {
      processed += 1;
      if (onProgress) onProgress(processed, files.length);
    }
  }
  return { results, errors };
};

const loadFolderFromManifest = async (folder, sourceLabel = folder) => {
  try {
    const normalized = folder.replace(/\/+$/, "");
    activeFolder = normalized;
    const manifestUrl = `${normalized}/${DEFAULT_MANIFEST}`;
    setLoadingState(true, "Loading manifest...");
    const res = await fetch(manifestUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error("Manifest is not an array");
    const files = list
      .filter((name) => typeof name === "string" && name.trim())
      .map((name) => ({ name, src: `${normalized}/${name}` }));
    if (!files.length) {
      setWarning([`No images found in ${manifestUrl}`]);
      return;
    }
    setLoadingState(true, `Loading images 0/${files.length}...`);
    const { results, errors } = await fetchAsBlobs(files, (loaded, total) => {
      setLoadingState(true, `Loading images ${loaded}/${total}...`);
    });
    fetchErrors = errors;
    if (!results.length) {
      setWarning([`Could not read images from ${normalized}`]);
      return;
    }
    failedImages = [];
    const { groups, warnings } = parseFiles(results);
    const combinedWarnings = warnings.slice();
    if (errors.length) combinedWarnings.push(`Failed to fetch ${errors.length} file(s) from ${normalized}`);
    renderCases({ groups, warnings: combinedWarnings });
    setSourceValue(sourceLabel);
    startScreenEl.hidden = true;
  } catch (err) {
    console.warn("Auto-load default folder failed:", err);
    setWarning([
      `Could not auto-load ${folder} (missing/invalid manifest).`,
    ]);
    setSourceValue(`${sourceLabel} (failed)`);
  } finally {
    if (!startScreenEl.hidden) setLoadingState(false);
  }
};

const getBaseName = (fileName) => {
  const name = fileName.split("/").pop() || fileName;
  const lastDot = name.lastIndexOf(".");
  return lastDot === -1 ? name : name.slice(0, lastDot);
};

const getExtension = (fileName) => {
  const name = fileName.split("/").pop() || fileName;
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1) return "";
  return name.slice(lastDot + 1).toLowerCase();
};

const isImageFile = (file) => IMAGE_EXTENSIONS.has(getExtension(file.name));

const getOriginalSuffix = (name) => {
  return ORIGINAL_SUFFIXES.find((suffix) => name.endsWith(suffix)) || "";
};

const getSegmentationSuffix = (name) => {
  if (name.endsWith("-gt")) return "-gt";
  if (name.endsWith("-argmax")) return "-argmax";
  const thresholdMatch = name.match(THRESHOLD_SUFFIX_PATTERN);
  if (thresholdMatch) return `-thr${thresholdMatch[1]}`;
  return "";
};

const isAllowedSegmentation = (name) => Boolean(getSegmentationSuffix(name));

const getThresholdDigits = (suffix) => {
  const match = suffix.match(THRESHOLD_SUFFIX_PATTERN);
  return match ? match[1] : "";
};

const getSegmentationSortOrder = (suffix) => {
  if (suffix === "-gt") return 0;
  if (suffix === "-argmax") return 1;
  const digits = getThresholdDigits(suffix);
  if (digits) return 100 + Number.parseInt(digits, 10);
  return 9999;
};

const getSegmentationLabel = (suffix, fallback) => {
  if (SEGMENTATION_LABELS.has(suffix)) return SEGMENTATION_LABELS.get(suffix);
  const digits = getThresholdDigits(suffix);
  if (digits) return `Threshold ${digits}`;
  return fallback;
};

const deriveBaseKeys = (names) => {
  const baseKeys = new Set();
  names.forEach((name) => {
    const suffix = getOriginalSuffix(name);
    if (suffix) baseKeys.add(name.slice(0, -suffix.length));
  });
  return baseKeys;
};

const pickBaseKey = (name, baseKeys) => {
  let best = "";
  baseKeys.forEach((base) => {
    const hasOriginal = ORIGINAL_SUFFIXES.some(
      (suffix) => name === `${base}${suffix}`
    );
    if (name === base || hasOriginal || name.startsWith(`${base}-`)) {
      if (base.length > best.length) best = base;
    }
  });
  if (!best) {
    const suffix = getOriginalSuffix(name);
    if (suffix) return name.slice(0, -suffix.length);
    if (name.includes("-")) return name.slice(0, name.lastIndexOf("-"));
  }
  return best || name;
};

const parseFiles = (files) => {
  const imageFiles = files.filter(isImageFile);
  const nameToFiles = new Map();

  imageFiles.forEach((file) => {
    const base = getBaseName(file.name);
    if (!nameToFiles.has(base)) nameToFiles.set(base, []);
    nameToFiles.get(base).push(file);
  });

  const names = Array.from(nameToFiles.keys());
  const baseKeys = deriveBaseKeys(names);
  const groups = new Map();
  const warnings = [];

  imageFiles.forEach((file) => {
    const baseName = getBaseName(file.name);
    const baseKey = pickBaseKey(baseName, baseKeys);
    if (!groups.has(baseKey)) {
      groups.set(baseKey, { original: null, segs: [] });
    }
    const group = groups.get(baseKey);
    if (getOriginalSuffix(baseName)) {
      if (!group.original) {
        group.original = file;
      } else {
        warnings.push("Multiple originals found for a case");
        if (isAllowedSegmentation(baseName)) group.segs.push(file);
      }
    } else if (isAllowedSegmentation(baseName)) {
      group.segs.push(file);
    }
  });

  return { groups, warnings };
};

const setWarning = (warnings) => {
  const items = [...warnings];
  if (fetchErrors.length) {
    const sample = fetchErrors.slice(0, 3).join(", ");
    const folderName = activeFolder || "selected source";
    items.push(
      `Fetch failed for ${fetchErrors.length} file(s) from ${folderName}` +
        (sample ? ` (e.g., ${sample})` : "")
    );
  }
  if (failedImages.length) {
    const sample = failedPreviewSample.join(", ");
    items.push(
      `Preview failed for ${failedImages.length} file(s)` +
        (sample ? ` (e.g., ${sample})` : "") +
        `. See console for details.`
    );
  }
  if (!items.length) {
    warningEl.hidden = true;
    warningEl.textContent = "";
    return;
  }
  warningEl.hidden = false;
  warningEl.textContent = items.join(" · ");
};

const updateCounts = () => {
  caseCountEl.textContent = selections.size;
  const chosen = Array.from(selections.values()).filter(Boolean).length;
  selectedCountEl.textContent = chosen;
  downloadCsvBtn.disabled = selections.size === 0;
};

const renderCases = ({ groups, warnings }) => {
  revokeUrls();
  casesEl.innerHTML = "";
  selections = new Map();
  failedImages = [];
  failedPreviewSample = [];
  fetchErrors = [];
  lastWarnings = warnings;

  const sortedKeys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

  sortedKeys.forEach((baseKey, index) => {
    const group = groups.get(baseKey);
    const caseNode = caseTemplate.content.cloneNode(true);
    const titleEl = caseNode.querySelector(".case-title");
    const subtitleEl = caseNode.querySelector(".case-subtitle");
    const originalImg = caseNode.querySelector(".original-img");
    const originalFallback = caseNode.querySelector(".original-wrap .img-fallback");
    const segGrid = caseNode.querySelector(".seg-grid");
    const pill = caseNode.querySelector(".selection-pill");

    titleEl.textContent = `Case ${index + 1}`;
    const segCount = group.segs.length;
    subtitleEl.textContent = `${segCount} option${segCount === 1 ? "" : "s"}`;

    selections.set(baseKey, "");

    if (group.original) {
      attachImage(originalImg, group.original, originalFallback, "Original");
    } else {
      originalImg.remove();
      originalFallback.hidden = false;
      originalFallback.textContent = "Original not found";
    }

    const segFiles = group.segs
      .slice()
      .sort((a, b) => {
        const aSuffix = getSegmentationSuffix(getBaseName(a.name));
        const bSuffix = getSegmentationSuffix(getBaseName(b.name));
        const aOrder = getSegmentationSortOrder(aSuffix);
        const bOrder = getSegmentationSortOrder(bSuffix);
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.name.localeCompare(b.name);
      });
    segFiles.forEach((segFile, segIndex) => {
      const segNode = segTemplate.content.cloneNode(true);
      const card = segNode.querySelector(".seg-card");
      const radio = segNode.querySelector(".seg-radio");
      const img = segNode.querySelector(".seg-img");
      const fallback = segNode.querySelector(".img-fallback");
      const selectBtn = segNode.querySelector(".select-btn");
      const labelEl = segNode.querySelector(".seg-label");
      const fileEl = segNode.querySelector(".seg-file");

      radio.name = `seg-${baseKey}`;
      radio.value = segFile.name;
      const segSuffix = getSegmentationSuffix(getBaseName(segFile.name));
      labelEl.textContent = getSegmentationLabel(segSuffix, `Option ${segIndex + 1}`);
      fileEl.textContent = "";
      fileEl.hidden = true;

      attachImage(img, segFile, fallback, "Option");

      radio.addEventListener("change", () => {
        selections.set(baseKey, radio.value);
        pill.textContent = "Selected";
        pill.dataset.state = "selected";
        segGrid.querySelectorAll(".select-btn").forEach((btn) => {
          btn.textContent = "Select";
          btn.dataset.state = "idle";
        });
        selectBtn.textContent = "Selected";
        selectBtn.dataset.state = "selected";
        updateCounts();
      });

      segGrid.appendChild(segNode);
    });

    casesEl.appendChild(caseNode);
  });

  setWarning(warnings);
  updateCounts();
};

const toCsv = () => {
  const rows = [["case", "selected_file"]];
  Array.from(selections.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([base, selected]) => {
      rows.push([base, selected || ""]);
    });
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
};

downloadCsvBtn.addEventListener("click", () => {
  const csv = toCsv();
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "segmentation-selections.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});

viewerEl.addEventListener("click", (event) => {
  if (event.target.dataset.close === "true") closeViewer();
});

viewerCloseEl.addEventListener("click", closeViewer);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !viewerEl.hidden) closeViewer();
});

const applyZoom = () => {
  viewerImageEl.style.transform = `scale(${viewerScale})`;
};

zoomInBtn?.addEventListener("click", () => {
  viewerScale = Math.min(viewerScale + 0.25, 5);
  applyZoom();
});

zoomOutBtn?.addEventListener("click", () => {
  viewerScale = Math.max(viewerScale - 0.25, 0.25);
  applyZoom();
});

zoomResetBtn?.addEventListener("click", () => {
  viewerScale = 1;
  applyZoom();
});

casesEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) return;
  if (!target.classList.contains("original-img") && !target.classList.contains("seg-img")) {
    return;
  }
  if (!target.src) return;
  openViewer(target.src, target.alt || "Preview");
});

document.addEventListener("DOMContentLoaded", () => {
  setLoadingState(false);
  startButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const folder = btn.dataset.folder;
      const sourceLabel = btn.dataset.label || folder || "Unknown";
      if (folder) {
        setSourceValue(`${sourceLabel} (loading)`);
        loadFolderFromManifest(folder, sourceLabel);
      }
    });
  });
});
