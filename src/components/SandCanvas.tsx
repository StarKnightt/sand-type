import { useEffect, useRef, useState } from 'react'
import { canRunSand, SandField } from '../sand/SandField'

export default function SandCanvas() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [supported] = useState(canRunSand)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !supported) return
    let field: SandField | null = null
    try {
      field = new SandField(host)
    } catch (err) {
      console.warn(err)
    }
    return () => field?.dispose()
  }, [supported])

  return (
    <div ref={hostRef} aria-hidden="true" className="absolute inset-0">
      {!supported && (
        <div className="grid h-full place-items-center font-word text-[min(26vw,48vh)] leading-none font-black text-[#c9a978] select-none">
          sand
        </div>
      )}
    </div>
  )
}
