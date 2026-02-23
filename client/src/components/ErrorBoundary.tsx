import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  showDetails: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, showDetails: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const { showDetails, error } = this.state;
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-background">
          <div className="flex flex-col items-center w-full max-w-2xl p-8">
            <AlertTriangle
              size={48}
              className="text-destructive mb-6 flex-shrink-0"
            />

            <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
            <p className="text-muted-foreground text-sm mb-6 text-center">
              An unexpected error occurred. Try reloading the page — if it keeps happening, please refresh and try again.
            </p>

            {error && (
              <div className="w-full mb-6">
                <button
                  onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2"
                >
                  {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {showDetails ? "Hide" : "Show"} technical details
                </button>
                {showDetails && (
                  <div className="p-4 w-full rounded bg-muted overflow-auto">
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-all">
                      {error.stack ?? error.message}
                    </pre>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => window.location.reload()}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg",
                "bg-primary text-primary-foreground",
                "hover:opacity-90 cursor-pointer"
              )}
            >
              <RotateCcw size={16} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
