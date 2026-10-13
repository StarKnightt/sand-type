import SandCanvas from './components/SandCanvas'

export default function App() {
  return (
    <main className="fixed inset-0 overflow-hidden bg-cream">
      <h1 className="sr-only">sand</h1>
      <SandCanvas />
      <p className="pointer-events-none absolute inset-x-0 bottom-7 text-center font-label text-[11px] tracking-[0.2em] text-stone-400 select-none">
        drag through it
      </p>
    </main>
  )
}
