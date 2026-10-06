import { Skeleton } from '@/components/ui/skeleton';

// Layout-stable placeholders that mirror the real dashboard/list and task-page geometry. They are decorative
// (aria-hidden) and sit inside an aria-busy region whose polite status text carries the loading message.
// `skeletonSpec` is the single source of row counts/heights so the behaviour checks can assert the shape.
export const skeletonSpec = {
  taskRows: 6, taskRowHeight: 'h-[52px]', activityItems: 4, quickOpenItems: 3,
  outputRows: 3, inputRows: 2, fileRowHeight: 'h-[44px]',
} as const;
const pulse = 'motion-reduce:animate-none';

function Line({ w, h = 'h-3' }: { w: string; h?: string }) { return <Skeleton className={`${h} ${w} ${pulse}`} />; }

export function LoadingRegion({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return <div aria-busy="true" className={className}><p role="status" aria-live="polite" className="sr-only">{label}</p><div aria-hidden="true">{children}</div></div>;
}

function TaskRowSkeleton() {
  return <div className={`${skeletonSpec.taskRowHeight} grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,9rem)_minmax(0,10rem)_auto]`}>
    <Skeleton className={`size-8 rounded-md ${pulse}`} />
    <div className="space-y-1.5"><Line w="w-2/3" h="h-3.5" /><Line w="w-1/3" h="h-2.5" /></div>
    <div className="hidden sm:block"><Line w="w-24" /></div>
    <div className="hidden sm:block"><Line w="w-28" /></div>
    <div className="flex gap-0.5"><Skeleton className={`size-8 rounded-md ${pulse}`} /><Skeleton className={`size-8 rounded-md ${pulse}`} /></div>
  </div>;
}

export function TaskListSkeleton({ withRail = true, label = 'Reading your Cowork folders from OneDrive' }: { withRail?: boolean; label?: string }) {
  return <LoadingRegion label={label} className={`grid gap-3 ${withRail ? 'xl:grid-cols-[minmax(0,1fr)_280px]' : ''}`}>
    <section className="min-w-0 space-y-2">
      <div className="flex items-center gap-2"><Line w="w-24" h="h-6" /><span className="ml-auto"><Line w="w-40" /></span></div>
      <div className="flex flex-wrap items-center gap-2"><Skeleton className={`h-7 w-56 rounded-md ${pulse}`} /><Skeleton className={`h-7 w-32 rounded-md ${pulse}`} /><Skeleton className={`h-7 w-28 rounded-md ${pulse}`} /></div>
      <div className="fl-card divide-y overflow-hidden">{Array.from({ length: skeletonSpec.taskRows }).map((_, i) => <TaskRowSkeleton key={i} />)}</div>
    </section>
    {withRail && <aside className="min-w-0 space-y-3">
      <section className="fl-card p-3"><Line w="w-28" h="h-4" /><ol className="mt-3 space-y-0 border-l border-border pl-3">{Array.from({ length: skeletonSpec.activityItems }).map((_, i) => <li key={i} className="relative space-y-1.5 py-2"><span className="absolute -left-[17px] top-3 size-2 rounded-full bg-accent" /><Line w="w-3/4" h="h-3.5" /><Line w="w-1/2" h="h-2.5" /><Line w="w-1/4" h="h-2.5" /></li>)}</ol></section>
      <section className="fl-card p-3"><Line w="w-20" h="h-4" /><ul className="mt-3 space-y-2">{Array.from({ length: skeletonSpec.quickOpenItems }).map((_, i) => <li key={i} className="flex items-center gap-2"><Skeleton className={`size-7 rounded-md ${pulse}`} /><div className="flex-1 space-y-1.5"><Line w="w-1/2" h="h-3.5" /><Line w="w-2/3" h="h-2.5" /></div></li>)}</ul></section>
    </aside>}
  </LoadingRegion>;
}

export function SectionSkeleton({ rows = 3, label = 'Reading your Cowork folders from OneDrive' }: { rows?: number; label?: string }) {
  return <LoadingRegion label={label} className="space-y-2">
    <Line w="w-28" h="h-6" />
    <div className="fl-card divide-y overflow-hidden">{Array.from({ length: rows }).map((_, i) => <div key={i} className={`${skeletonSpec.fileRowHeight} flex items-center gap-2 px-3`}><Skeleton className={`size-4 rounded ${pulse}`} /><div className="flex-1 space-y-1.5"><Line w="w-1/3" h="h-3.5" /><Line w="w-2/3" h="h-2.5" /></div><Skeleton className={`h-6 w-16 rounded-md ${pulse}`} /></div>)}</div>
  </LoadingRegion>;
}

function FileRowSkeleton() {
  return <div className={`${skeletonSpec.fileRowHeight} grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,8rem)_minmax(0,9rem)_auto]`}>
    <Skeleton className={`size-4 rounded ${pulse}`} /><Line w="w-1/2" h="h-3.5" /><div className="hidden sm:block"><Line w="w-20" /></div><div className="hidden sm:block"><Line w="w-24" /></div><Skeleton className={`h-6 w-16 rounded-md ${pulse}`} />
  </div>;
}

export function TaskPageSkeleton({ label = 'Loading this task from the last OneDrive read' }: { label?: string }) {
  return <LoadingRegion label={label} className="mx-auto w-full max-w-[1100px] space-y-3">
    <div className="flex items-center gap-2"><Skeleton className={`h-6 w-16 rounded-md ${pulse}`} /><Line w="w-10" /><Line w="w-24" /><Line w="w-40" /></div>
    <div className="fl-card p-3"><div className="flex flex-wrap items-start gap-2"><div className="min-w-0 flex-1 space-y-2"><Line w="w-2/3" h="h-5" /><Line w="w-1/2" h="h-3" /></div><div className="flex gap-1"><Skeleton className={`h-8 w-16 rounded-md ${pulse}`} /><Skeleton className={`h-8 w-20 rounded-md ${pulse}`} /><Skeleton className={`h-8 w-32 rounded-md ${pulse}`} /></div></div></div>
    <section className="space-y-1"><div className="flex items-center gap-2 px-1"><Line w="w-20" h="h-4" /><Line w="w-48" /></div><div className="fl-card divide-y overflow-hidden">{Array.from({ length: skeletonSpec.outputRows }).map((_, i) => <FileRowSkeleton key={i} />)}</div></section>
    <section className="space-y-1"><div className="flex items-center gap-2 px-1"><Line w="w-14" h="h-3.5" /><Line w="w-12" /></div><div className="fl-card divide-y overflow-hidden">{Array.from({ length: skeletonSpec.inputRows }).map((_, i) => <FileRowSkeleton key={i} />)}</div></section>
  </LoadingRegion>;
}

/** File-row placeholders for a task whose folders are still being inspected (the page header stays real; only the lists wait). */
export function FileListSkeleton({ rows = skeletonSpec.outputRows, label }: { rows?: number; label?: string }) {
  const body = <div className="fl-card divide-y overflow-hidden">{Array.from({ length: rows }).map((_, i) => <FileRowSkeleton key={i} />)}</div>;
  return label ? <LoadingRegion label={label}>{body}</LoadingRegion> : <div aria-hidden="true">{body}</div>;
}
