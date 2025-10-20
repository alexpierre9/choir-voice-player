import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { APP_LOGO, APP_TITLE, getLoginUrl } from "@/const";
import { Music, Upload, Users, Volume2 } from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";

export default function Home() {
  const { user, isAuthenticated, logout } = useAuth();
  const [, setLocation] = useLocation();

  const { data: userSheets } = trpc.sheetMusic.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Music className="h-8 w-8 text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">
              {APP_TITLE || "Choir Voice Player"}
            </h1>
          </div>
          
          <div className="flex items-center gap-4">
            {isAuthenticated ? (
              <>
                <span className="text-sm text-gray-600">
                  {user?.name || user?.email}
                </span>
                <Button variant="outline" onClick={() => logout()}>
                  Log Out
                </Button>
              </>
            ) : (
              <Button onClick={() => window.location.href = getLoginUrl()}>
                Log In
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <div className="container mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-5xl font-bold text-gray-900 mb-4">
            Play Every Voice in Your Choir
          </h2>
          <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
            Upload sheet music and hear each SATB voice part individually. Perfect
            for choir practice, learning, and arrangement analysis.
          </p>
          
          <Button
            size="lg"
            onClick={() => setLocation("/upload")}
            className="text-lg px-8 py-6"
          >
            <Upload className="mr-2 h-5 w-5" />
            Upload Sheet Music
          </Button>
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          <Card className="p-6 text-center">
            <div className="bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Upload className="h-8 w-8 text-blue-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Easy Upload</h3>
            <p className="text-gray-600">
              Upload PDF or MusicXML files. Our AI analyzes the sheet music
              automatically.
            </p>
          </Card>

          <Card className="p-6 text-center">
            <div className="bg-green-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Users className="h-8 w-8 text-green-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Auto Voice Detection</h3>
            <p className="text-gray-600">
              Automatically detects Soprano, Alto, Tenor, and Bass parts with
              manual override options.
            </p>
          </Card>

          <Card className="p-6 text-center">
            <div className="bg-purple-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Volume2 className="h-8 w-8 text-purple-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Individual Playback</h3>
            <p className="text-gray-600">
              Play each voice separately or together. Control volume and mute
              individual parts.
            </p>
          </Card>
        </div>

        {/* Recent Uploads */}
        {isAuthenticated && userSheets && userSheets.length > 0 && (
          <div>
            <h3 className="text-2xl font-bold text-gray-900 mb-4">
              Your Recent Uploads
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {userSheets.slice(0, 6).map((sheet) => (
                <Card
                  key={sheet.id}
                  className="p-4 hover:shadow-lg transition-shadow cursor-pointer"
                  onClick={() => setLocation(`/sheet/${sheet.id}`)}
                >
                  <div className="flex items-start gap-3">
                    <Music className="h-6 w-6 text-blue-500 flex-shrink-0 mt-1" />
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold truncate">{sheet.title}</h4>
                      <p className="text-sm text-gray-500 truncate">
                        {sheet.originalFilename}
                      </p>
                      <div className="mt-2">
                        {sheet.status === "ready" && (
                          <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
                            Ready
                          </span>
                        )}
                        {sheet.status === "processing" && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                            Processing...
                          </span>
                        )}
                        {sheet.status === "error" && (
                          <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded">
                            Error
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* How It Works */}
        <div className="mt-16">
          <h3 className="text-3xl font-bold text-center text-gray-900 mb-8">
            How It Works
          </h3>
          <div className="max-w-3xl mx-auto space-y-6">
            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  1
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">Upload Your Score</h4>
                  <p className="text-gray-600">
                    Upload a PDF or MusicXML file of your choir arrangement. We
                    support both scanned PDFs (using optical music recognition) and
                    digital MusicXML files.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  2
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">
                    Automatic Voice Detection
                  </h4>
                  <p className="text-gray-600">
                    Our system analyzes the sheet music and automatically identifies
                    which parts belong to Soprano, Alto, Tenor, and Bass based on
                    clefs, pitch ranges, and part names.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  3
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">
                    Review and Adjust
                  </h4>
                  <p className="text-gray-600">
                    Check the detected voice assignments. If needed, manually adjust
                    which parts correspond to which voices using the dropdown menus.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex gap-4">
                <div className="bg-blue-500 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold flex-shrink-0">
                  4
                </div>
                <div>
                  <h4 className="font-semibold text-lg mb-1">
                    Play and Practice
                  </h4>
                  <p className="text-gray-600">
                    Use the MIDI player to play each voice individually or together.
                    Control the volume of each part, mute voices, and follow along
                    with your score.
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t bg-white/80 backdrop-blur-sm mt-16">
        <div className="container mx-auto px-6 py-8 text-center text-gray-600">
          <p>© 2025 Choir Voice Player. Built for choir directors and singers.</p>
        </div>
      </footer>
    </div>
  );
}

