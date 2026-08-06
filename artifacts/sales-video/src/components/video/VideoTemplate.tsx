// Video Template - Contains all scenes and duration logic

import type { ComponentType } from "react";
import { useEffect, useRef } from "react";

import { useVideoPlayer } from "@/lib/video";
import { AnimatePresence } from "framer-motion";

import { Scene1_Pain } from "./video_scenes/Scene1_Pain";
import { Scene2_Intro } from "./video_scenes/Scene2_Intro";
import { Scene3_Flow } from "./video_scenes/Scene3_Flow";
import { Scene4_Backend } from "./video_scenes/Scene4_Backend";
import { Scene5_Outro } from "./video_scenes/Scene5_Outro";

export const SCENE_DURATIONS = {
  scene1: 4000,
  scene2: 4500,
  scene3: 6500,
  scene4: 5000,
  scene5: 5000,
};

const SCENE_COMPONENTS: Record<string, ComponentType> = {
  scene1: Scene1_Pain,
  scene2: Scene2_Intro,
  scene3: Scene3_Flow,
  scene4: Scene4_Backend,
  scene5: Scene5_Outro,
};

const SCENE_START_SEC: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let cumulativeMs = 0;
  for (const [key, ms] of Object.entries(SCENE_DURATIONS)) {
    out[key] = cumulativeMs / 1000;
    cumulativeMs += ms;
  }
  return out;
})();

const AUDIO_SEEK_EPSILON_SEC = 0.18;

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  muted = false,
  onSceneChange,
}: {
  durations?: Record<string, number>;
  loop?: boolean;
  muted?: boolean;
  onSceneChange?: (sceneKey: string) => void;
} = {}) {
  const { currentSceneKey } = useVideoPlayer({ durations, loop });

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, "");
  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 0.45;
    const targetTime = SCENE_START_SEC[baseSceneKey] ?? 0;
    if (Math.abs(audio.currentTime - targetTime) > AUDIO_SEEK_EPSILON_SEC) {
      audio.currentTime = targetTime;
    }
    audio.play().catch(() => {});
  }, [currentSceneKey, baseSceneKey, muted]);

  return (
    <div
      className="w-full h-screen overflow-hidden relative"
      style={{ backgroundColor: "var(--color-bg-light)" }}
    >
      <AnimatePresence mode="popLayout">
        {SceneComponent && <SceneComponent key={currentSceneKey} />}
      </AnimatePresence>

      <audio
        ref={audioRef}
        src={`${import.meta.env.BASE_URL}audio/bg_music.mp3`}
        preload="auto"
        autoPlay
        muted={muted}
      />
    </div>
  );
}
