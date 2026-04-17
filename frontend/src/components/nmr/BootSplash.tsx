import { Atom, Loader2 } from "lucide-react";

interface BootSplashProps {
  message: string;
  error?: string | null;
}

export function BootSplash({ message, error }: BootSplashProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gradient-surface">
      <div className="relative">
        <div className="absolute inset-0 animate-pulse-glow rounded-full" />
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-primary shadow-elegant">
          <Atom className="h-10 w-10 text-primary-foreground" />
        </div>
      </div>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">NMR Predict</h1>
      <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
        {!error && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {error ?? message}
      </p>
    </div>
  );
}
