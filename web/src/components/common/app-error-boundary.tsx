import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto my-8 max-w-xl rounded-xl border border-bad/40 bg-bad-soft p-6 text-center">
        <h1 className="text-base font-semibold text-foreground">Page rendering failed / 页面渲染失败 / 表示に失敗しました</h1>
        <p className="mt-2 text-sm text-muted-foreground">Reload the page. If the problem continues, check the monitor service log.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          Reload
        </button>
      </div>
    );
  }
}
