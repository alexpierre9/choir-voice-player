import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Header from "@/components/Header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload as UploadIcon, FileMusic, FileText, FileCode, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { Progress } from "@/components/ui/progress";

// F-02: map of accepted extensions → file type
const ACCEPTED_EXTENSIONS: Record<string, "pdf" | "musicxml"> = {
  ".pdf": "pdf",
  ".xml": "musicxml",
  ".musicxml": "musicxml",
  ".mxl": "musicxml",
};

function getFileType(name: string): "pdf" | "musicxml" | null {
  const lower = name.toLowerCase();
  for (const [ext, type] of Object.entries(ACCEPTED_EXTENSIONS)) {
    if (lower.endsWith(ext)) return type;
  }
  return null;
}

export default function Upload() {
  // Redirect to /login (with return path) if the user is not authenticated.
  useAuth({ redirectOnUnauthenticated: true });

  const [, setLocation] = useLocation();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  // F-08: track drag-over state for visual feedback
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // F-02: reject files whose extension is not an accepted music format
      if (!getFileType(file.name)) {
        toast.error("Unsupported file type. Please upload a PDF or MusicXML file (.pdf, .xml, .musicxml, .mxl).");
        e.target.value = "";
        return;
      }
      if (file.size > 50 * 1024 * 1024) { // 50MB limit
        toast.error("File too large. Maximum size is 50MB");
        return;
      }
      setSelectedFile(file);
      setTitle(file.name.replace(/\.[^/.]+$/, ""));
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      toast.error("Please select a file");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      // Build multipart FormData — no base64 encoding needed
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("title", title || selectedFile.name);

      // Use XMLHttpRequest so we can track upload progress
      const sheetId = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        });

        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText);
              resolve(data.sheetId);
            } catch {
              reject(new Error("Invalid server response"));
            }
          } else {
            let msg = `Upload failed (${xhr.status})`;
            try {
              const data = JSON.parse(xhr.responseText);
              if (data.error) msg = data.error;
            } catch { /* ignore */ }
            reject(new Error(msg));
          }
        });

        xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
        xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));

        xhr.open("POST", "/api/upload");
        xhr.send(formData);
      });

      toast.success("File uploaded successfully! Processing...");
      setLocation(`/sheet/${sheetId}`);
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message}`);
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false); // F-08
    const file = e.dataTransfer.files[0];
    if (file) {
      // F-02: reject unsupported extensions on drop too
      if (!getFileType(file.name)) {
        toast.error("Unsupported file type. Please upload a PDF or MusicXML file (.pdf, .xml, .musicxml, .mxl).");
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        toast.error("File too large. Maximum size is 50MB");
        return;
      }
      setSelectedFile(file);
      setTitle(file.name.replace(/\.[^/.]+$/, ""));
    }
  };

  // F-08: visual feedback while dragging a file over the drop zone
  const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 p-6">
      <Header />
      <div className="container max-w-4xl mx-auto">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
            Upload Sheet Music
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            Upload sheet music and play individual SATB voices
          </p>
        </div>

        <Card className="p-8">
          <div className="space-y-6">
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload sheet music file"
              className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer ${
                isDragging
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                  : "border-gray-300 hover:border-blue-500"
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.xml,.musicxml,.mxl"
                onChange={handleFileSelect}
                className="hidden"
              />

              {selectedFile ? (
                <div className="space-y-3">
                  <FileMusic className="mx-auto h-16 w-16 text-blue-500" />
                  <div>
                    <p className="text-lg font-medium">{selectedFile.name}</p>
                    <div className="flex items-center justify-center gap-2 mt-1">
                      {getFileType(selectedFile.name) === "pdf" ? (
                        <Badge variant="secondary" className="flex items-center gap-1">
                          <FileText className="h-3 w-3" /> PDF
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="flex items-center gap-1">
                          <FileCode className="h-3 w-3" /> MusicXML
                        </Badge>
                      )}
                      <span className="text-sm text-muted-foreground">
                        {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFile(null);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <UploadIcon className="mx-auto h-16 w-16 text-gray-400" />
                  <div>
                    <p className="text-lg font-medium">
                      Drop your file here or click to browse
                    </p>
                    <p className="text-sm text-gray-500">
                      Supports PDF and MusicXML
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="title">Title (optional)</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter a title for this sheet music"
              />
            </div>

            {isUploading && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-300">
                  <span>Uploading…</span>
                  <span>{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} className="h-2" />
              </div>
            )}

            <Button
              onClick={handleUpload}
              disabled={!selectedFile || isUploading}
              className="w-full"
              size="lg"
            >
              {isUploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <UploadIcon className="mr-2 h-4 w-4" />
                  Upload and Process
                </>
              )}
            </Button>

            {/* Info */}
            <div className="mt-8 p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
              <h3 className="font-semibold mb-2 dark:text-gray-100">How it works:</h3>
              <ol className="list-decimal list-inside space-y-1 text-sm text-gray-700 dark:text-gray-300">
                <li>Upload your PDF or MusicXML choir sheet music</li>
                <li>We automatically detect Soprano, Alto, Tenor, and Bass voices</li>
                <li>Adjust voice assignments if needed</li>
                <li>Play each voice individually or together with volume controls</li>
              </ol>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
