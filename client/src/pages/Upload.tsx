import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Header from "@/components/Header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload as UploadIcon, FileMusic, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
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
  const [uploadPhase, setUploadPhase] = useState<"idle" | "reading" | "uploading">("idle");
  const [readProgress, setReadProgress] = useState(0);
  // F-08: track drag-over state for visual feedback
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = trpc.sheetMusic.upload.useMutation({
    onSuccess: (data) => {
      toast.success("File uploaded successfully! Processing...");
      setLocation(`/sheet/${data.id}`);
    },
    onError: (error) => {
      toast.error(`Upload failed: ${error.message}`);
      setIsUploading(false);
      setUploadPhase("idle");
    },
  });

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
    setUploadPhase("reading");
    setReadProgress(0);

    const base64Content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (e.lengthComputable) {
          setReadProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      reader.onload = (e) => {
        const base64Data = e.target?.result as string;
        resolve(base64Data.split(",")[1]);
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(selectedFile);
    }).catch((err) => {
      toast.error(err.message);
      setIsUploading(false);
      setUploadPhase("idle");
      return null;
    });

    if (!base64Content) return;

    setUploadPhase("uploading");

    // F-02: validated extension → type (getFileType returns non-null here since we validated on select/drop)
    const fileType = getFileType(selectedFile.name) ?? "musicxml";
    await uploadMutation.mutateAsync({
      filename: selectedFile.name,
      fileType,
      fileData: base64Content,
      title: title || selectedFile.name,
    });
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
                    <p className="text-sm text-gray-500">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
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

            {uploadPhase === "reading" && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-300">
                  <span>Reading file…</span>
                  <span>{readProgress}%</span>
                </div>
                <Progress value={readProgress} className="h-2" />
              </div>
            )}

            {uploadPhase === "uploading" && (
              <div className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-300">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                <span>Uploading…</span>
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
                  {uploadPhase === "reading" ? "Reading file…" : "Uploading…"}
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
