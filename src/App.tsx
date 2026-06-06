import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MERGE_ENDPOINT = "http://localhost:8080/api/pdf/merge";
const SPLIT_ENDPOINT = "http://localhost:8080/api/pdf/split";
const THUMBNAIL_WIDTH = 180;

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

type UploadStatus = "idle" | "uploading" | "success" | "error";
type ActiveTool = "merge" | "split";

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
      className={`group relative flex min-h-64 flex-col rounded-2xl border bg-white p-2 text-left shadow-sm transition ${
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
      <div className="flex flex-1 items-center justify-center overflow-hidden rounded-xl bg-slate-100">
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

  const toolCopy =
    activeTool === "merge"
      ? {
          title: "Merge PDFs without the clutter.",
          description:
            "Drop your PDFs, review the queue, and send them to the local merge service. The merged file downloads automatically when it is ready.",
        }
      : {
          title: "Split one PDF into the pages you need.",
          description:
            "Upload a PDF, choose pages from visual thumbnails, and download the result returned by the local split service.",
        };

  const isSplitReady =
    Boolean(splitFile) &&
    selectedSplitPages.length > 0 &&
    !isSplitPreviewLoading &&
    splitStatus !== "uploading";

  const tabClass = (tool: ActiveTool) =>
    `flex-1 rounded-full px-4 py-2 text-sm font-semibold transition ${
      activeTool === tool
        ? "bg-slate-950 text-white shadow-sm"
        : "text-slate-500 hover:bg-white hover:text-slate-900"
    }`;

  const dropZoneClass = (isDragging: boolean) =>
    `flex min-h-[260px] cursor-pointer flex-col items-center justify-center rounded-[22px] border border-dashed px-6 py-10 text-center transition ${
      isDragging
        ? "border-cyan-500 bg-cyan-50"
        : "border-slate-300 bg-slate-50 hover:border-cyan-500 hover:bg-cyan-50/60"
    }`;

  const messageClass = (status: UploadStatus) =>
    `border-t border-slate-200 px-5 py-4 text-sm ${
      status === "error" ? "text-rose-600" : "text-slate-600"
    }`;

  const renderUploadIcon = () => (
    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-300">
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

  const renderFileRow = (
    file: File,
    onRemove: () => void,
    removeLabel: string,
    disabled: boolean,
  ) => (
    <li
      className="flex items-center gap-3 rounded-2xl px-3 py-3 transition hover:bg-slate-50"
      key={`${file.name}-${file.size}-${file.lastModified}`}
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-sm font-bold text-rose-600">
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

  return (
    <main className="min-h-screen bg-[#f7f8fb] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-6xl content-center gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
        <div className="max-w-xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700">
            FileConvy
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950 sm:text-5xl">
            {toolCopy.title}
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-slate-600">
            {toolCopy.description}
          </p>
        </div>

        <div className="rounded-[28px] border border-slate-200 bg-white p-3 shadow-[0_24px_80px_rgba(15,23,42,0.10)] sm:p-4">
          <div className="mb-4 flex rounded-full bg-slate-100 p-1">
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
          </div>

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
                <h2 className="mt-6 text-2xl font-semibold tracking-normal">
                  Drag and drop PDFs here
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  or click to browse and select multiple files
                </p>
              </div>

              <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200 bg-white">
                <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold tracking-normal">
                      Selected PDFs
                    </h2>
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
                      className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      type="button"
                      onClick={clearMergeFiles}
                      disabled={mergeFiles.length === 0 || mergeStatus === "uploading"}
                    >
                      Clear
                    </button>
                    <button
                      className="rounded-full bg-cyan-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-600/20 transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
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
                    <li className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
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
          ) : (
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
                <h2 className="mt-6 text-2xl font-semibold tracking-normal">
                  Drag and drop one PDF here
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  or click to browse and replace the selected file
                </p>
              </div>

              <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-lg font-semibold tracking-normal">
                        Split settings
                      </h2>
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
                            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            type="button"
                            onClick={selectAllSplitPages}
                            disabled={splitStatus === "uploading"}
                          >
                            Select all
                          </button>
                          <button
                            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
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
                        className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
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
                    <div className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                      No PDF selected yet.
                    </div>
                  )}
                </div>

                {splitFile ? (
                  <div className="border-t border-slate-200 bg-slate-50/60 p-4 sm:p-5">
                    {isSplitPreviewLoading ? (
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-10 text-center text-sm font-medium text-slate-500">
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

                    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">
                          Selected pages
                        </p>
                        <p className="mt-1 truncate text-sm text-slate-500">
                          {selectedPagesText || "No pages selected"}
                        </p>
                      </div>
                      <button
                        className="min-h-11 rounded-full bg-cyan-600 px-5 text-sm font-semibold text-white shadow-lg shadow-cyan-600/20 transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
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
          )}
        </div>
      </section>
    </main>
  );
}

export default App;
