import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Reusable error boundary for a single dashboard panel. A crash inside one
 * panel renders a small "couldn't load" card in its place instead of
 * white-screening the whole app; the rest of the page keeps working.
 *
 * - Retry re-mounts the children via a `key` bump so transient render errors
 *   get a genuine second chance, not a re-render of the same broken tree.
 * - The boundary lives inside each page, so navigating away unmounts it and
 *   the next visit starts fresh — never a stuck error card.
 * - The original error is re-reported to the console so it stays debuggable.
 */
export class PanelErrorBoundary extends Component<
  { label?: string; children: ReactNode },
  { hasError: boolean; attempt: number }
> {
  state = { hasError: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Keep the underlying failure visible to developers.
    console.error(
      `[PanelErrorBoundary] ${this.props.label ?? "panel"} crashed:`,
      error,
      info.componentStack,
    );
  }

  private retry = () => {
    this.setState((s) => ({ hasError: false, attempt: s.attempt + 1 }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-card border border-border rounded-xl shadow-sm p-8 text-center">
          <div className="w-10 h-10 bg-secondary rounded-full flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>
          <h3 className="font-semibold text-foreground mb-1">
            This section couldn&apos;t load
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-4">
            Something went wrong showing{" "}
            {this.props.label
              ? `the ${this.props.label}`
              : "this part of the page"}
            . The rest of the app is still working.
          </p>
          <Button variant="outline" onClick={this.retry} className="gap-2">
            <RefreshCw className="w-4 h-4" /> Try again
          </Button>
        </div>
      );
    }
    // Bumping the key on retry discards the crashed subtree entirely.
    return (
      <div key={this.state.attempt} className="contents">
        {this.props.children}
      </div>
    );
  }
}
