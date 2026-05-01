"use client"

import { memo, useRef } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import type { Mesh } from "three"
import { cn } from "@/lib/utils"

function RotatingMesh() {
  const meshRef = useRef<Mesh | null>(null)

  useFrame((_, delta) => {
    if (!meshRef.current) {
      return
    }

    meshRef.current.rotation.x += delta * 0.4
    meshRef.current.rotation.y += delta * 0.6
  })

  return (
    <mesh ref={meshRef}>
      <torusKnotGeometry args={[0.9, 0.25, 128, 24]} />
      <meshStandardMaterial color="#0ea5e9" metalness={0.3} roughness={0.35} />
    </mesh>
  )
}

interface ThreeSceneRichOutputProps {
  prompt?: string
  height?: number
  className?: string
}

export const ThreeSceneRichOutput = memo(function ThreeSceneRichOutput({
  prompt,
  height = 320,
  className,
}: ThreeSceneRichOutputProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border/60 bg-background/70 p-3",
        className
      )}
    >
      {prompt ? <div className="mb-2 text-xs text-muted-foreground">{prompt}</div> : null}
      <div style={{ height }}>
        <Canvas camera={{ position: [0, 0, 4.5], fov: 50 }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[4, 4, 4]} intensity={1.2} />
          <RotatingMesh />
          <OrbitControls enablePan={false} />
        </Canvas>
      </div>
    </div>
  )
})
