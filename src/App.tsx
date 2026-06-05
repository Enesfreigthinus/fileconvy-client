import { useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

const MERGE_ENDPOINT = "http://localhost:8080/api/pdf/merge";

type UploadStatus = "idle" | "uploading" | "success" | "error";

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

function getDownloadFileName(headers: Headers) {
  const disposition = headers.get("content-disposition");
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);

  return match?.[1] ? decodeURIComponent(match[1]) : "merged.pdf";
}

function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );

  const addFiles = (incomingFiles: FileList | File[]) => {
    const pdfFiles = Array.from(incomingFiles).filter(
      (file) => file.type === "application/pdf" || file.name.endsWith(".pdf"),
    );

    if (pdfFiles.length === 0) {
      setStatus("error");
      setMessage("Only PDF files can be added.");
      return;
    }

    setFiles((currentFiles) => {
      const knownFiles = new Set(
        currentFiles.map((file) => `${file.name}-${file.size}-${file.lastModified}`),
      );
      const uniqueFiles = pdfFiles.filter(
        (file) => !knownFiles.has(`${file.name}-${file.size}-${file.lastModified}`),
      );

      return [...currentFiles, ...uniqueFiles];
    });
    setStatus("idle");
    setMessage("");
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      addFiles(event.target.files);
      event.target.value = "";
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const handleMerge = async () => {
    if (files.length === 0 || status === "uploading") {
      return;
    }

    const formData = new FormData();
    files.forEach((file) => {
      formData.append("files", file);
    });

    setStatus("uploading");
    setMessage("Uploading PDFs for merge...");

    try {
      const response = await fetch(MERGE_ENDPOINT, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Merge failed with status ${response.status}`);
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.href = downloadUrl;
      anchor.download = getDownloadFileName(response.headers);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);

      setStatus("success");
      setMessage("Merged PDF downloaded.");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while merging the files.",
      );
    }
  };

  const removeFile = (fileToRemove: File) => {
    setFiles((currentFiles) =>
      currentFiles.filter((file) => file !== fileToRemove),
    );
  };

  const clearFiles = () => {
    setFiles([]);
    setStatus("idle");
    setMessage("");
  };

  return (
    <main className="min-h-screen bg-[#f7f8fb] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-6xl content-center gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
        <div className="max-w-xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700">
            FileConvy
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950 sm:text-5xl">
            Merge PDFs without the clutter.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-slate-600">
            Drop your PDFs, review the queue, and send them to the local merge
            service. The merged file downloads automatically when it is ready.
          </p>
        </div>

        <div className="rounded-[28px] border border-slate-200 bg-white p-3 shadow-[0_24px_80px_rgba(15,23,42,0.10)] sm:p-4">
          <div
            className={`flex min-h-[300px] cursor-pointer flex-col items-center justify-center rounded-[22px] border border-dashed px-6 py-10 text-center transition ${
              isDragging
                ? "border-cyan-500 bg-cyan-50"
                : "border-slate-300 bg-slate-50 hover:border-cyan-500 hover:bg-cyan-50/60"
            }`}
            onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                inputRef.current?.click();
              }
            }}
          >
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={handleFileChange}
            />
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
            <h2 className="mt-6 text-2xl font-semibold tracking-normal">
              Drag and drop PDFs here
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              or click to browse and select multiple files
            </p>
          </div>

          <div className="mt-4 rounded-3xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold tracking-normal">
                  Selected PDFs
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {files.length} file{files.length === 1 ? "" : "s"} selected
                  {files.length > 0 ? `, ${formatFileSize(totalSize)} total` : ""}
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  onClick={clearFiles}
                  disabled={files.length === 0 || status === "uploading"}
                >
                  Clear
                </button>
                <button
                  className="rounded-full bg-cyan-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-600/20 transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                  type="button"
                  onClick={handleMerge}
                  disabled={files.length === 0 || status === "uploading"}
                >
                  {status === "uploading" ? "Merging..." : "Merge"}
                </button>
              </div>
            </div>

            <ul className="max-h-72 overflow-y-auto p-3">
              {files.length === 0 ? (
                <li className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  No PDFs selected yet.
                </li>
              ) : (
                files.map((file) => (
                  <li
                    className="flex items-center gap-3 rounded-2xl px-3 py-3 transition hover:bg-slate-50"
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-sm font-bold text-rose-600">
                      PDF
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {file.name}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatFileSize(file.size)}
                      </p>
                    </div>
                    <button
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => removeFile(file)}
                      disabled={status === "uploading"}
                    >
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
                    </button>
                  </li>
                ))
              )}
            </ul>

            {message ? (
              <p
                className={`border-t border-slate-200 px-5 py-4 text-sm ${
                  status === "error" ? "text-rose-600" : "text-slate-600"
                }`}
                role="status"
              >
                {message}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
