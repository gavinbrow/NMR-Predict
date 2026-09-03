import { Atom } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { NavLink } from "@/components/NavLink";
import { cn } from "@/lib/utils";

interface AppShellProps {
  children: ReactNode;
  headerAccessory?: ReactNode;
  mainClassName?: string;
}

const navLinkClassName =
  "rounded-full px-3 py-2 text-sm font-semibold text-muted-foreground transition-smooth hover:bg-background hover:text-foreground";

const navLinkActiveClassName = "bg-background text-foreground shadow-card";

export function AppShell({
  children,
  headerAccessory,
  mainClassName = "container py-6",
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-gradient-surface">
      <header className="border-b border-border/60 bg-background/75 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex flex-col gap-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Link
              to="/"
              className="flex items-center gap-3 rounded-2xl outline-none transition-smooth focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-primary shadow-elegant">
                <Atom className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight">NMR Predict</h1>
                <p className="text-xs text-muted-foreground">
                  Prediction and spectrum analysis workspace
                </p>
              </div>
            </Link>

            <nav
              aria-label="Primary"
              className="flex rounded-full border border-border/70 bg-muted/40 p-1"
            >
              <NavLink
                to="/analysis"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                Spectrum analysis
              </NavLink>
              <NavLink
                to="/prediction"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                Prediction
              </NavLink>
              <NavLink
                to="/kinetics"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                NMR Kinetics
              </NavLink>
              <NavLink
                to="/maldi"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                MALDI
              </NavLink>
              <NavLink
                to="/gcms"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                GC/MS
              </NavLink>
              <NavLink
                to="/ir"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                IR
              </NavLink>
              <NavLink
                to="/tensile"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                Tensile
              </NavLink>
              <NavLink
                to="/tga"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                TGA
              </NavLink>
              <NavLink
                to="/dsc"
                className={navLinkClassName}
                activeClassName={navLinkActiveClassName}
              >
                DSC
              </NavLink>
            </nav>
          </div>

          {headerAccessory ? (
            <div className={cn("flex flex-wrap items-center gap-3 text-xs", "lg:justify-end")}>
              {headerAccessory}
            </div>
          ) : null}
        </div>
      </header>

      <main className={mainClassName}>{children}</main>
    </div>
  );
}
