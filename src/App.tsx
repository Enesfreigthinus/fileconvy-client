import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import heroImage from "./assets/fileconvy-hero.png";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MERGE_ENDPOINT = "http://localhost:8080/api/pdf/merge";
const SPLIT_ENDPOINT = "http://localhost:8080/api/pdf/split";
const COMPRESS_ENDPOINT = "http://localhost:8080/api/pdf/compress";
const THUMBNAIL_WIDTH = 180;

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

type UploadStatus = "idle" | "uploading" | "success" | "error";
type ActiveTool = "merge" | "split" | "compress";

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function getDownloadFileName(headers: Headers, fallbackName: string) {
  const disposition = headers.get("content-disposition");
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);

  return match?.[1] ? decodeURIComponent(match[1]) : fallbackName;
}

async function getResponseError(response: Response, fallbackMessage: string) {
  try {
    const data = (await response.json()) as { error?: string };

    return data.error ?? fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

async function downloadResponseFile(response: Response, fallbackName: string) {
  const contentType = response.headers.get("content-type") ?? "";
  const fallbackDownloadName = contentType.includes("zip")
    ? fallbackName.replace(/\.[^.]+$/, ".zip")
    : fallbackName;
  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = downloadUrl;
  anchor.download = getDownloadFileName(response.headers, fallbackDownloadName);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(downloadUrl);
}

function isPDF(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

type PdfPageThumbnailProps = {
  disabled: boolean;
  isSelected: boolean;
  onToggle: () => void;
  pageNumber: number;
  pdfDocument: PDFDocumentProxy;
};

function PdfPageThumbnail({
  disabled,
  isSelected,
  onToggle,
  pageNumber,
  pdfDocument,
}: PdfPageThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendering, setIsRendering] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let isActive = true;
    let renderTask: RenderTask | null = null;

    const renderPage = async () => {
      const canvas = canvasRef.current;

      if (!canvas) {
        return;
      }

      setIsRendering(true);
      setHasError(false);

      try {
        const page = await pdfDocument.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = THUMBNAIL_WIDTH / baseViewport.width;
        const viewport = page.getViewport({ scale });

        if (!isActive) {
          return;
        }

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        renderTask = page.render({
          canvas,
          viewport,
        });

        await renderTask.promise;

        if (isActive) {
          setIsRendering(false);
        }
      } catch (error) {
        if (
          !isActive ||
          (error instanceof Error && error.name === "RenderingCancelledException")
        ) {
          return;
        }

        setHasError(true);
        setIsRendering(false);
      }
    };

    void renderPage();

    return () => {
      isActive = false;
      renderTask?.cancel();
    };
  }, [pageNumber, pdfDocument]);

  return (
    <button
      className={`group relative flex min-h-64 flex-col rounded-lg border bg-white p-2 text-left shadow-sm transition ${
        isSelected
          ? "border-cyan-500 shadow-lg shadow-cyan-600/15 ring-4 ring-cyan-100"
          : "border-slate-200 hover:border-cyan-300 hover:shadow-md"
      } disabled:cursor-not-allowed disabled:opacity-70`}
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={isSelected}
      aria-label={`${isSelected ? "Deselect" : "Select"} page ${pageNumber}`}
    >
      <div className="flex flex-1 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
        {hasError ? (
          <span className="px-3 text-center text-xs font-medium text-rose-600">
            Preview unavailable
          </span>
        ) : null}
        <canvas
          ref={canvasRef}
          className={`max-h-full max-w-full bg-white transition ${
            isRendering || hasError ? "hidden" : "block"
          }`}
        />
        {isRendering && !hasError ? (
          <span className="text-xs font-medium text-slate-400">Rendering</span>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-900">Page {pageNumber}</span>
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full border transition ${
            isSelected
              ? "border-cyan-600 bg-cyan-600 text-white"
              : "border-slate-300 text-transparent group-hover:border-cyan-400"
          }`}
          aria-hidden="true"
        >
          {isSelected ? (
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.2"
              viewBox="0 0 24 24"
            >
              <path d="m5 12 4 4L19 6" />
            </svg>
          ) : null}
        </span>
      </div>
    </button>
  );
}

function App() {
  const [activeTool, setActiveTool] = useState<ActiveTool>("merge");

  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  const [isMergeDragging, setIsMergeDragging] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<UploadStatus>("idle");
  const [mergeMessage, setMergeMessage] = useState("");
  const mergeInputRef = useRef<HTMLInputElement>(null);

  const [splitFile, setSplitFile] = useState<File | null>(null);
  const [splitDocument, setSplitDocument] = useState<PDFDocumentProxy | null>(null);
  const [selectedSplitPages, setSelectedSplitPages] = useState<number[]>([]);
  const [isSplitPreviewLoading, setIsSplitPreviewLoading] = useState(false);
  const [isSplitDragging, setIsSplitDragging] = useState(false);
  const [splitStatus, setSplitStatus] = useState<UploadStatus>("idle");
  const [splitMessage, setSplitMessage] = useState("");
  const splitInputRef = useRef<HTMLInputElement>(null);

  const [compressFile, setCompressFile] = useState<File | null>(null);
  const [isCompressDragging, setIsCompressDragging] = useState(false);
  const [compressStatus, setCompressStatus] = useState<UploadStatus>("idle");
  const [compressMessage, setCompressMessage] = useState("");
  const compressInputRef = useRef<HTMLInputElement>(null);

  const totalMergeSize = useMemo(
    () => mergeFiles.reduce((sum, file) => sum + file.size, 0),
    [mergeFiles],
  );

  const selectedPagesText = selectedSplitPages.join(",");

  useEffect(() => {
    let isActive = true;
    let loadedDocument: PDFDocumentProxy | null = null;

    if (!splitFile) {
      setSplitDocument(null);
      setSelectedSplitPages([]);
      setIsSplitPreviewLoading(false);
      return;
    }

    setSplitDocument(null);
    setSelectedSplitPages([]);
    setIsSplitPreviewLoading(true);
    setSplitStatus("idle");
    setSplitMessage("Preparing page previews...");

    const loadDocument = async () => {
      try {
        const fileBuffer = await splitFile.arrayBuffer();
        const document = await getDocument({
          data: new Uint8Array(fileBuffer),
        }).promise;
        loadedDocument = document;

        if (!isActive) {
          await document.loadingTask.destroy();
          return;
        }

        setSplitDocument(document);
        setIsSplitPreviewLoading(false);
        setSplitMessage("");
      } catch (error) {
        if (!isActive) {
          return;
        }

        setSplitDocument(null);
        setIsSplitPreviewLoading(false);
        setSplitStatus("error");
        setSplitMessage(
          error instanceof Error
            ? error.message
            : "Could not prepare page previews for this PDF.",
        );
      }
    };

    void loadDocument();

    return () => {
      isActive = false;
      if (loadedDocument) {
        void loadedDocument.loadingTask.destroy();
      }
    };
  }, [splitFile]);

  const addMergeFiles = (incomingFiles: FileList | File[]) => {
    const pdfFiles = Array.from(incomingFiles).filter(isPDF);

    if (pdfFiles.length === 0) {
      setMergeStatus("error");
      setMergeMessage("Only PDF files can be added.");
      return;
    }

    setMergeFiles((currentFiles) => {
      const knownFiles = new Set(
        currentFiles.map((file) => `${file.name}-${file.size}-${file.lastModified}`),
      );
      const uniqueFiles = pdfFiles.filter(
        (file) => !knownFiles.has(`${file.name}-${file.size}-${file.lastModified}`),
      );

      return [...currentFiles, ...uniqueFiles];
    });
    setMergeStatus("idle");
    setMergeMessage("");
  };

  const handleMergeFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addMergeFiles(event.target.files);
      event.target.value = "";
    }
  };

  const handleMergeDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsMergeDragging(false);
    addMergeFiles(event.dataTransfer.files);
  };

  const handleMerge = async () => {
    if (mergeFiles.length === 0 || mergeStatus === "uploading") {
      return;
    }

    const formData = new FormData();
    mergeFiles.forEach((file) => {
      formData.append("files", file);
    });

    setMergeStatus("uploading");
    setMergeMessage("Uploading PDFs for merge...");

    try {
      const response = await fetch(MERGE_ENDPOINT, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(
          await getResponseError(response, `Merge failed with status ${response.status}`),
        );
      }

      await downloadResponseFile(response, "merged.pdf");

      setMergeStatus("success");
      setMergeMessage("Merged PDF downloaded.");
    } catch (error) {
      setMergeStatus("error");
      setMergeMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while merging the files.",
      );
    }
  };

  const removeMergeFile = (fileToRemove: File) => {
    setMergeFiles((currentFiles) =>
      currentFiles.filter((file) => file !== fileToRemove),
    );
  };

  const clearMergeFiles = () => {
    setMergeFiles([]);
    setMergeStatus("idle");
    setMergeMessage("");
  };

  const addSplitFile = (incomingFiles: FileList | File[]) => {
    const pdfFile = Array.from(incomingFiles).find(isPDF);

    if (!pdfFile) {
      setSplitStatus("error");
      setSplitMessage("Choose one PDF file to split.");
      return;
    }

    setSplitFile(pdfFile);
    setSelectedSplitPages([]);
    setSplitStatus("idle");
    setSplitMessage("");
  };

  const handleSplitFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addSplitFile(event.target.files);
      event.target.value = "";
    }
  };

  const handleSplitDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsSplitDragging(false);
    addSplitFile(event.dataTransfer.files);
  };

  const clearSplitFile = () => {
    setSplitFile(null);
    setSplitDocument(null);
    setSelectedSplitPages([]);
    setIsSplitPreviewLoading(false);
    setSplitStatus("idle");
    setSplitMessage("");
  };

  const handleSplit = async () => {
    if (
      !splitFile ||
      selectedSplitPages.length === 0 ||
      isSplitPreviewLoading ||
      splitStatus === "uploading"
    ) {
      return;
    }

    const formData = new FormData();
    formData.append("file", splitFile);
    formData.append("pages", selectedPagesText);

    setSplitStatus("uploading");
    setSplitMessage("Uploading PDF for split...");

    try {
      const response = await fetch(SPLIT_ENDPOINT, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(
          await getResponseError(response, `Split failed with status ${response.status}`),
        );
      }

      await downloadResponseFile(response, "split.pdf");

      setSplitStatus("success");
      setSplitMessage("Split file downloaded.");
    } catch (error) {
      setSplitStatus("error");
      setSplitMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while splitting the file.",
      );
    }
  };

  const toggleSplitPage = (pageNumber: number) => {
    setSelectedSplitPages((currentPages) => {
      if (currentPages.includes(pageNumber)) {
        return currentPages.filter((page) => page !== pageNumber);
      }

      return [...currentPages, pageNumber].sort((firstPage, secondPage) => firstPage - secondPage);
    });

    if (splitStatus !== "uploading") {
      setSplitStatus("idle");
      setSplitMessage("");
    }
  };

  const selectAllSplitPages = () => {
    if (!splitDocument) {
      return;
    }

    setSelectedSplitPages(
      Array.from({ length: splitDocument.numPages }, (_, index) => index + 1),
    );
    setSplitStatus("idle");
    setSplitMessage("");
  };

  const clearSelectedSplitPages = () => {
    setSelectedSplitPages([]);
    setSplitStatus("idle");
    setSplitMessage("");
  };

  const addCompressFile = (incomingFiles: FileList | File[]) => {
    const pdfFile = Array.from(incomingFiles).find(isPDF);

    if (!pdfFile) {
      setCompressStatus("error");
      setCompressMessage("Choose one PDF file to compress.");
      return;
    }

    setCompressFile(pdfFile);
    setCompressStatus("idle");
    setCompressMessage("");
  };

  const handleCompressFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addCompressFile(event.target.files);
      event.target.value = "";
    }
  };

  const handleCompressDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsCompressDragging(false);

    if (compressStatus === "uploading") {
      return;
    }

    addCompressFile(event.dataTransfer.files);
  };

  const clearCompressFile = () => {
    setCompressFile(null);
    setCompressStatus("idle");
    setCompressMessage("");
  };

  const handleCompress = async () => {
    if (!compressFile || compressStatus === "uploading") {
      return;
    }

    const formData = new FormData();
    formData.append("file", compressFile);

    setCompressStatus("uploading");
    setCompressMessage("Compressing PDF...");

    try {
      const response = await fetch(COMPRESS_ENDPOINT, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(
          await getResponseError(
            response,
            `Compress failed with status ${response.status}`,
          ),
        );
      }

      await downloadResponseFile(response, "compressed.pdf");

      setCompressStatus("success");
      setCompressMessage("Compressed PDF downloaded.");
    } catch (error) {
      setCompressStatus("error");
      setCompressMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while compressing the file.",
      );
    }
  };

  const toolCopy =
    activeTool === "merge"
      ? {
          title: "Merge PDFs without the clutter",
          description:
            "Drop several PDFs, review the queue, and let FileConvy return one clean document.",
        }
      : activeTool === "split"
        ? {
            title: "Split only the pages you need",
            description:
              "Preview every page, select the exact range, and download a focused file.",
          }
        : {
            title: "Compress PDFs into lighter files",
            description:
              "Upload one PDF, send it to the compression service, and get a smaller copy automatically.",
          };

  const isSplitReady =
    Boolean(splitFile) &&
    selectedSplitPages.length > 0 &&
    !isSplitPreviewLoading &&
    splitStatus !== "uploading";

  const tabClass = (tool: ActiveTool) =>
    `min-w-0 flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
      activeTool === tool
        ? "bg-[#192126] text-white shadow-sm"
        : "text-slate-500 hover:bg-white hover:text-slate-900"
    }`;

  const dropZoneClass = (isDragging: boolean) =>
    `flex min-h-[220px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition ${
      isDragging
        ? "border-cyan-500 bg-cyan-50"
        : "border-slate-300 bg-[#f7faf9] hover:border-cyan-500 hover:bg-cyan-50/70"
    }`;

  const messageClass = (status: UploadStatus) =>
    `border-t border-slate-200 px-5 py-4 text-sm ${
      status === "error" ? "text-rose-600" : "text-slate-600"
    }`;

  const renderUploadIcon = () => (
    <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-[#192126] text-white shadow-lg shadow-slate-300">
      <svg
        aria-hidden="true"
        className="h-8 w-8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <path d="M12 16V4" />
        <path d="m7 9 5-5 5 5" />
        <path d="M20 16.5v1.75A1.75 1.75 0 0 1 18.25 20H5.75A1.75 1.75 0 0 1 4 18.25V16.5" />
      </svg>
    </div>
  );

  const renderRemoveIcon = () => (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );

  const renderSpinnerIcon = () => (
    <svg
      aria-hidden="true"
      className="h-4 w-4 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-90"
        d="M4 12a8 8 0 0 1 8-8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="4"
      />
    </svg>
  );

  const renderFileRow = (
    file: File,
    onRemove: () => void,
    removeLabel: string,
    disabled: boolean,
  ) => (
    <li
      className="flex items-center gap-3 rounded-lg px-3 py-3 transition hover:bg-slate-50"
      key={`${file.name}-${file.size}-${file.lastModified}`}
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#fff0ed] text-sm font-bold text-[#d94b3f]">
        PDF
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">{file.name}</p>
        <p className="mt-1 text-xs text-slate-500">{formatFileSize(file.size)}</p>
      </div>
      <button
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        disabled={disabled}
      >
        {renderRemoveIcon()}
      </button>
    </li>
  );

  const renderToolPanel = () => (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-[0_24px_80px_rgba(25,33,38,0.12)] sm:p-4">
      <div className="grid gap-4 border-b border-slate-200 pb-4 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <p className="text-sm font-semibold text-cyan-700">
            Live workspace
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950 sm:text-3xl">
            {toolCopy.title}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            {toolCopy.description}
          </p>
        </div>
        <div className="flex rounded-lg bg-slate-100 p-1">
          <button
            className={tabClass("merge")}
            type="button"
            onClick={() => setActiveTool("merge")}
          >
            Merge PDF
          </button>
          <button
            className={tabClass("split")}
            type="button"
            onClick={() => setActiveTool("split")}
          >
            Split PDF
          </button>
          <button
            className={tabClass("compress")}
            type="button"
            onClick={() => setActiveTool("compress")}
          >
            Compress
          </button>
        </div>
      </div>

      <div className="pt-4">
        {activeTool === "merge" ? (
          <>
            <div
              className={dropZoneClass(isMergeDragging)}
              onClick={() => mergeInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsMergeDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsMergeDragging(false)}
              onDrop={handleMergeDrop}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  mergeInputRef.current?.click();
                }
              }}
            >
              <input
                ref={mergeInputRef}
                className="sr-only"
                type="file"
                accept="application/pdf,.pdf"
                multiple
                onChange={handleMergeFileChange}
              />
              {renderUploadIcon()}
              <h3 className="mt-6 text-2xl font-semibold">
                Drag and drop PDFs here
              </h3>
              <p className="mt-2 text-sm text-slate-500">
                or click to browse and select multiple files
              </p>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold">Selected PDFs</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    {mergeFiles.length} file
                    {mergeFiles.length === 1 ? "" : "s"} selected
                    {mergeFiles.length > 0
                      ? `, ${formatFileSize(totalMergeSize)} total`
                      : ""}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    onClick={clearMergeFiles}
                    disabled={mergeFiles.length === 0 || mergeStatus === "uploading"}
                  >
                    Clear
                  </button>
                  <button
                    className="rounded-lg bg-[#007f8a] px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-700/20 transition hover:bg-[#006b73] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                    type="button"
                    onClick={handleMerge}
                    disabled={mergeFiles.length === 0 || mergeStatus === "uploading"}
                  >
                    {mergeStatus === "uploading" ? "Merging..." : "Merge PDF"}
                  </button>
                </div>
              </div>

              <ul className="max-h-72 overflow-y-auto p-3">
                {mergeFiles.length === 0 ? (
                  <li className="rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                    No PDFs selected yet.
                  </li>
                ) : (
                  mergeFiles.map((file) =>
                    renderFileRow(
                      file,
                      () => removeMergeFile(file),
                      `Remove ${file.name}`,
                      mergeStatus === "uploading",
                    ),
                  )
                )}
              </ul>

              {mergeMessage ? (
                <p className={messageClass(mergeStatus)} role="status">
                  {mergeMessage}
                </p>
              ) : null}
            </div>
          </>
        ) : activeTool === "split" ? (
          <>
            <div
              className={dropZoneClass(isSplitDragging)}
              onClick={() => splitInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsSplitDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsSplitDragging(false)}
              onDrop={handleSplitDrop}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  splitInputRef.current?.click();
                }
              }}
            >
              <input
                ref={splitInputRef}
                className="sr-only"
                type="file"
                accept="application/pdf,.pdf"
                onChange={handleSplitFileChange}
              />
              {renderUploadIcon()}
              <h3 className="mt-6 text-2xl font-semibold">
                Drag and drop one PDF here
              </h3>
              <p className="mt-2 text-sm text-slate-500">
                or click to browse and replace the selected file
              </p>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">Split settings</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {splitDocument
                        ? `${selectedSplitPages.length} of ${splitDocument.numPages} pages selected`
                        : "Select one PDF to preview its pages."}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {splitDocument ? (
                      <>
                        <button
                          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          type="button"
                          onClick={selectAllSplitPages}
                          disabled={splitStatus === "uploading"}
                        >
                          Select all
                        </button>
                        <button
                          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          type="button"
                          onClick={clearSelectedSplitPages}
                          disabled={
                            selectedSplitPages.length === 0 ||
                            splitStatus === "uploading"
                          }
                        >
                          Clear selection
                        </button>
                      </>
                    ) : null}
                    <button
                      className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      type="button"
                      onClick={clearSplitFile}
                      disabled={!splitFile || splitStatus === "uploading"}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              <div className="p-3">
                {splitFile ? (
                  <ul>
                    {renderFileRow(
                      splitFile,
                      clearSplitFile,
                      `Remove ${splitFile.name}`,
                      splitStatus === "uploading",
                    )}
                  </ul>
                ) : (
                  <div className="rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                    No PDF selected yet.
                  </div>
                )}
              </div>

              {splitFile ? (
                <div className="border-t border-slate-200 bg-[#f7faf9] p-4 sm:p-5">
                  {isSplitPreviewLoading ? (
                    <div className="rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm font-medium text-slate-500">
                      Preparing page previews...
                    </div>
                  ) : null}

                  {splitDocument ? (
                    <div className="grid max-h-[34rem] grid-cols-2 gap-4 overflow-y-auto pr-1 sm:grid-cols-3 xl:grid-cols-4">
                      {Array.from(
                        { length: splitDocument.numPages },
                        (_, index) => index + 1,
                      ).map((pageNumber) => (
                        <PdfPageThumbnail
                          key={`${splitFile.name}-${splitFile.lastModified}-${pageNumber}`}
                          disabled={splitStatus === "uploading"}
                          isSelected={selectedSplitPages.includes(pageNumber)}
                          onToggle={() => toggleSplitPage(pageNumber)}
                          pageNumber={pageNumber}
                          pdfDocument={splitDocument}
                        />
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        Selected pages
                      </p>
                      <p className="mt-1 truncate text-sm text-slate-500">
                        {selectedPagesText || "No pages selected"}
                      </p>
                    </div>
                    <button
                      className="min-h-11 rounded-lg bg-[#007f8a] px-5 text-sm font-semibold text-white shadow-lg shadow-cyan-700/20 transition hover:bg-[#006b73] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                      type="button"
                      onClick={handleSplit}
                      disabled={!isSplitReady}
                    >
                      {splitStatus === "uploading" ? "Splitting..." : "Split PDF"}
                    </button>
                  </div>
                </div>
              ) : null}

              {splitMessage ? (
                <p className={messageClass(splitStatus)} role="status">
                  {splitMessage}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div
              className={dropZoneClass(isCompressDragging)}
              onClick={() => {
                if (compressStatus !== "uploading") {
                  compressInputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsCompressDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsCompressDragging(false)}
              onDrop={handleCompressDrop}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  if (compressStatus !== "uploading") {
                    compressInputRef.current?.click();
                  }
                }
              }}
            >
              <input
                ref={compressInputRef}
                className="sr-only"
                type="file"
                accept="application/pdf,.pdf"
                onChange={handleCompressFileChange}
                disabled={compressStatus === "uploading"}
              />
              {renderUploadIcon()}
              <h3 className="mt-6 text-2xl font-semibold">
                Drag and drop one PDF here
              </h3>
              <p className="mt-2 text-sm text-slate-500">
                or click to browse and replace the selected file
              </p>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-lg font-semibold">Compression queue</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    {compressFile
                      ? `${compressFile.name} - ${formatFileSize(compressFile.size)}`
                      : "Select one PDF to optimize."}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    onClick={clearCompressFile}
                    disabled={!compressFile || compressStatus === "uploading"}
                  >
                    Clear
                  </button>
                  <button
                    className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#007f8a] px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-700/20 transition hover:bg-[#006b73] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                    type="button"
                    onClick={handleCompress}
                    disabled={!compressFile || compressStatus === "uploading"}
                  >
                    {compressStatus === "uploading" ? (
                      <>
                        {renderSpinnerIcon()}
                        Compressing...
                      </>
                    ) : (
                      "Compress"
                    )}
                  </button>
                </div>
              </div>

              <div className="p-3">
                {compressFile ? (
                  <ul>
                    {renderFileRow(
                      compressFile,
                      clearCompressFile,
                      `Remove ${compressFile.name}`,
                      compressStatus === "uploading",
                    )}
                  </ul>
                ) : (
                  <div className="rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                    No PDF selected yet.
                  </div>
                )}
              </div>

              {compressStatus === "uploading" ? (
                <div className="border-t border-slate-200 bg-[#f7faf9] px-5 py-5">
                  <div className="flex items-center gap-3 rounded-lg border border-cyan-100 bg-white px-4 py-4 text-sm font-medium text-slate-700">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-50 text-[#007f8a]">
                      {renderSpinnerIcon()}
                    </span>
                    Optimizing your PDF and preparing the download...
                  </div>
                </div>
              ) : null}

              {compressMessage ? (
                <p className={messageClass(compressStatus)} role="status">
                  {compressMessage}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-[#f8faf9] text-slate-950">
      <section className="relative isolate overflow-hidden border-b border-slate-200 bg-[#eef4f2]">
        <img
          className="absolute inset-0 -z-10 h-full w-full object-cover object-center"
          src={heroImage}
          alt=""
          aria-hidden="true"
        />
        <div className="absolute inset-0 -z-10 bg-white/72" />

        <header className="mx-auto flex max-w-7xl items-center justify-between px-4 py-5 sm:px-6 lg:px-8">
          <a className="flex items-center gap-3 text-sm font-bold text-slate-950" href="#">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#192126] text-white">
              FC
            </span>
            FileConvy
          </a>
          <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 sm:flex">
            <a className="transition hover:text-slate-950" href="#workspace">
              Workspace
            </a>
            <a className="transition hover:text-slate-950" href="#workflow">
              Workflow
            </a>
            <a
              className="rounded-lg bg-[#192126] px-4 py-2 font-semibold text-white transition hover:bg-[#2a363c]"
              href="#workspace"
            >
              Start converting
            </a>
          </nav>
        </header>

        <div className="mx-auto flex min-h-[72vh] max-w-7xl items-center px-4 pb-16 pt-10 sm:min-h-[76vh] sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold text-[#007f8a]">
              PDF tools for focused document work
            </p>
            <h1 className="mt-5 text-5xl font-semibold leading-[1.02] text-slate-950 sm:text-6xl lg:text-7xl">
              FileConvy
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-700 sm:text-xl">
              A polished workspace for merging messy PDF batches, splitting long documents, and compressing heavy files into lighter downloads.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-[#007f8a] px-6 text-sm font-semibold text-white shadow-lg shadow-cyan-700/20 transition hover:bg-[#006b73]"
                href="#workspace"
              >
                Open workspace
              </a>
              <a
                className="inline-flex min-h-12 items-center justify-center rounded-lg border border-slate-300 bg-white/80 px-6 text-sm font-semibold text-slate-800 transition hover:border-slate-400 hover:bg-white"
                href="#workflow"
              >
                See workflow
              </a>
            </div>
            <dl className="mt-10 grid max-w-2xl grid-cols-3 gap-3">
              <div className="border-l border-slate-300 pl-4">
                <dt className="text-xs font-medium text-slate-500">Modes</dt>
                <dd className="mt-1 text-2xl font-semibold text-slate-950">3</dd>
              </div>
              <div className="border-l border-slate-300 pl-4">
                <dt className="text-xs font-medium text-slate-500">Preview</dt>
                <dd className="mt-1 text-2xl font-semibold text-slate-950">Pages</dd>
              </div>
              <div className="border-l border-slate-300 pl-4">
                <dt className="text-xs font-medium text-slate-500">Output</dt>
                <dd className="mt-1 text-2xl font-semibold text-slate-950">PDF</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section id="workspace" className="px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          {renderToolPanel()}
        </div>
      </section>

      <section id="workflow" className="border-t border-slate-200 bg-white px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
          <div>
            <p className="text-sm font-semibold text-[#d94b3f]">Simple by design</p>
            <h2 className="mt-3 text-3xl font-semibold text-slate-950 sm:text-4xl">
              Built for the small PDF jobs that should not become chores.
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["Drop", "Add PDFs directly into the active tool."],
              ["Review", "Check file order, size, selected pages, or compression queue."],
              ["Download", "Run the local service and receive the finished file."],
            ].map(([title, description]) => (
              <article
                className="rounded-lg border border-slate-200 bg-[#f8faf9] p-5"
                key={title}
              >
                <h3 className="text-base font-semibold text-slate-950">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
