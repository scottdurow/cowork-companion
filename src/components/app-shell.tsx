import { Outlet, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { Toaster } from "@/components/ui/sonner";
import { useEffect, useState } from "react";
import { CompanionProvider } from "@/lib/companion-session";

// Minimal app shell — provides only the layout frame: it owns the single
// `min-h-screen`, mounts the <Toaster/>, and plays a subtle entrance on each
// route. It deliberately ships NO navigation chrome. Decide per app what fits:
//   • a top navbar  → add a sticky <header> above <main> with <Link>s,
//   • a sidebar     → replace <main> with `SidebarInset`; never render both,
//   • or nothing    → single-screen / focused apps often need no nav at all.
// When you add nav, map over `routes` from `@/routes` so route + nav stay in sync.
// Pages fill <main flex-1> with `h-full`; never add `min-h-screen` inside a page.
// Toasts follow the resolved appearance: the session toggles .light/.dark on <html>; observe that class rather than the OS only.
function useResolvedScheme(): "light" | "dark" | "system" {
  const read = () => (document.documentElement.classList.contains("dark") ? "dark" : document.documentElement.classList.contains("light") ? "light" : "system") as "light" | "dark" | "system";
  const [scheme, setScheme] = useState(read);
  useEffect(() => { const observer = new MutationObserver(() => setScheme(read())); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); return () => observer.disconnect(); }, []);
  return scheme;
}
export function AppShell() {
  const { pathname } = useLocation();
  const scheme = useResolvedScheme();
  return (
    <CompanionProvider>
    <div className="flex h-full min-h-0 flex-col">
      <div id="companion-main" className="flex min-h-0 flex-1 flex-col">
        {/* key on pathname → each route re-mounts and replays the entrance.
            Entrance-only (no AnimatePresence/exit): an exit animation around
            <Outlet/> would animate the NEXT route's content, not the leaving one. */}
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Outlet />
        </motion.div>
      </div>
      <Toaster theme={scheme} />
    </div>
    </CompanionProvider>
  );
}

export default AppShell;
