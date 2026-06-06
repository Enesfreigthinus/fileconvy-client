# FileConvy Client

FileConvy Client is the browser interface for PDF tools. It lets a user merge multiple PDFs or split one PDF by selected pages, then downloads the file returned by the local service.

This repository contains the front-end only. PDF merging and splitting are handled by the companion server in `../fileconvy-server`.

## Scope

The current app supports:

- Selecting multiple PDF files from the browser.
- Dragging and dropping PDF files into the upload area.
- Showing the selected file count and total size.
- Removing individual files or clearing the whole list.
- Sending selected files to `http://localhost:8080/api/pdf/merge`.
- Downloading the merged PDF returned by the server.
- Selecting one PDF for splitting.
- Previewing split PDF pages as clickable thumbnails.
- Selecting and deselecting pages visually before splitting.
- Sending the split request to `http://localhost:8080/api/pdf/split`.
- Downloading the split file returned by the server.

The current app does not merge or split files inside the browser. The backend must be running for the PDF actions to produce downloads.

## Requirements

Install these before running the project:

- Node.js and npm for the client.
- Go for the companion server. The server `go.mod` currently declares Go `1.26.3`.
- A modern browser such as Chrome, Edge, Firefox, or Safari.

## Install The Client

From this directory:

```bash
npm install
```

## Run The Program Locally

You need two terminals: one for the server and one for the client.

1. Start the server:

```bash
cd ../fileconvy-server
go run ./cmd/server
```

The server listens on:

```text
http://localhost:8080
```

You can check that it is alive by opening:

```text
http://localhost:8080/ping
```

2. Start the client:

```bash
cd ../fileconvy-client
npm run dev
```

Vite will print the local client URL. By default it is usually:

```text
http://localhost:5173
```

Open that URL in your browser. Use Merge PDF for multiple files, or Split PDF for one file and visual page selection.

## Available Commands

```bash
npm run dev
```

Starts the Vite development server.

```bash
npm run build
```

Runs TypeScript checks and creates a production build in `dist`.

```bash
npm run preview
```

Serves the production build locally for a final check.

## Backend Contract

### Merge PDF

The client sends a `POST` request to:

```text
http://localhost:8080/api/pdf/merge
```

The request body is `multipart/form-data`. Each uploaded PDF is appended under the `files` field.

The server is expected to return:

- `200 OK`
- `Content-Type: application/pdf`
- A PDF file body
- Optionally, a `Content-Disposition` filename

If the server does not provide a filename, the client downloads the result as `merged.pdf`.

### Split PDF

The client sends a `POST` request to:

```text
http://localhost:8080/api/pdf/split
```

The request body is `multipart/form-data` with these fields:

- `file`: one PDF file
- `pages`: selected page numbers joined as a comma-separated string, such as `1,3,5`

The server is expected to return a downloadable PDF or ZIP file. If the server does not provide a filename, the client downloads the result as `split.pdf`.

## Troubleshooting

If a PDF action fails, check these first:

- Make sure the server is running on port `8080`.
- Make sure the client is running on `http://localhost:5173` or `http://localhost:3000`, because those origins are allowed by the server CORS setup.
- Select at least two PDF files for merging.
- Select one PDF file and choose page thumbnails for splitting.
- Confirm the files have a `.pdf` extension and valid PDF file content.
- If dependencies are missing, run `npm install` in the client and `go mod tidy` in the server.

## Project Structure

```text
fileconvy-client/
  src/
    App.tsx        Main PDF merge and split interface
    main.tsx       React entry point
    styles.css     Tailwind CSS import and base page styles
  index.html       Vite HTML entry
  package.json     Client scripts and dependencies
  vite.config.ts   Vite, React, and Tailwind configuration
```
