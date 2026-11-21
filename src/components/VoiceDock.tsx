import React, { useEffect, useRef, useState } from 'react';
import {
  MicOff,
  Square,
  Volume2,
  VolumeX,
  Radio,
  AlertCircle,
  BookOpen,
  Play,
  Pause,
  ChevronDown,
  Check,
  VideoOff,
} from 'lucide-react';
import type { StoryPlaybackStatus } from '../utils/audio';
import {
  AssistantLanguage,
  CameraFacingMode,
  LiveVideoMode,
  VOICE_PROFILES,
  VoiceGender,
} from '../types';
import { PWAInstallButton } from './PWAInstallButton';

interface VoiceDockProps {
  language: AssistantLanguage;
  onSelectLanguage: (lang: AssistantLanguage) => void;
  voiceGender: VoiceGender;
  onSelectVoiceGender: (gender: VoiceGender) => void;
  isLiveActive: boolean;
  liveStatus: 'idle' | 'connecting' | 'active' | 'error';
  liveErrorMessage?: string;
  micLevel: number;
  onToggleLive: () => void;
  isMuted: boolean;
  onToggleMute: () => void;
  videoMode: LiveVideoMode;
  cameraFacingMode: CameraFacingMode;
  videoError: string | null;
  videoPreviewRef: React.RefObject<HTMLVideoElement | null>;
  onStopVideo: () => void;
  storyStatus?: StoryPlaybackStatus;
  storyProgress?: { currentIndex: number; total: number };
  onPauseStory?: () => void;
  onResumeStory?: () => void;
  onStopStory?: () => void;
}

export const VoiceDock: React.FC<VoiceDockProps> = ({
  language,
  voiceGender,
  onSelectVoiceGender,
  isLiveActive,
  liveStatus,
  liveErrorMessage,
  micLevel,
  onToggleLive,
  isMuted,
  onToggleMute,
  videoMode,
  cameraFacingMode,
  videoError,
  videoPreviewRef,
  onStopVideo,
  storyStatus = 'idle',
  storyProgress = { currentIndex: 0, total: 0 },
  onPauseStory,
  onResumeStory,
  onStopStory,
}) => {
  const [isVoiceMenuOpen, setIsVoiceMenuOpen] = useState(false);
  const voiceDropdownRef = useRef<HTMLDivElement | null>(null);

  const activeProfile =
    VOICE_PROFILES.find((v) => v.id === voiceGender) || VOICE_PROFILES[0];
  const femaleVoices = VOICE_PROFILES.filter((v) => v.gender === 'female');
  const maleVoices = VOICE_PROFILES.filter((v) => v.gender === 'male');

  const isDe = language === 'de';
  const isListeningOrConnecting = isLiveActive || liveStatus === 'connecting';

  useEffect(() => {
    if (!isVoiceMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (
        voiceDropdownRef.current &&
        !voiceDropdownRef.current.contains(e.target as Node)
      ) {
        setIsVoiceMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsVoiceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isVoiceMenuOpen]);

  const activeVideoLabel =
    videoMode === 'screen'
      ? isDe
        ? 'Bildschirm wird geteilt'
        : 'Udostępniany ekran telefonu'
      : cameraFacingMode === 'environment'
        ? isDe
          ? 'Rückkamera aktiv'
          : 'Kamera tylna aktywna'
        : isDe
          ? 'Frontkamera aktiv'
          : 'Kamera przednia aktywna';

  return (
    <section
      aria-label={isDe ? 'Sprachassistent' : 'Asystent głosowy'}
      className="flex flex-col gap-4"
    >
      {/* Sleek Elevated Dark Glass-Slate Control Panel */}
      <div className="rounded-3xl border border-white/[0.08] bg-gradient-to-b from-[#0F1520] to-[#0A0E16] p-4 sm:p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] space-y-5">
        {/* Primary Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onToggleLive}
            className={`inline-flex min-h-[48px] flex-1 sm:flex-none items-center justify-center gap-2 rounded-2xl px-5 text-sm font-semibold transition-all whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22C55E] ${
              isListeningOrConnecting
                ? 'bg-[#DC2626] text-white hover:bg-[#B91C1C]'
                : 'bg-[#22C55E] text-[#041409] hover:bg-[#4ADE80] shadow-md shadow-[#22C55E]/20'
            }`}
          >
            {isListeningOrConnecting ? (
              <>
                <MicOff className="h-4 w-4" aria-hidden="true" />
                <span>{isDe ? 'Gespräch beenden' : 'Wyłącz rozmowę na żywo'}</span>
              </>
            ) : (
              <>
                <Radio className="h-4 w-4" aria-hidden="true" />
                <span>
                  {isDe ? 'Live-Gespräch mit Assistent' : 'Rozmowa na żywo z asystentem'}
                </span>
              </>
            )}
          </button>

          {isListeningOrConnecting && (
            <button
              type="button"
              onClick={onToggleMute}
              className={`inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border px-4 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22C55E] ${
                isMuted
                  ? 'border-[#F59E0B]/50 bg-[#261B04] text-[#FCD34D]'
                  : 'border-white/[0.09] bg-[#121926] text-[#E2E8F0] hover:border-[#22C55E]/60 hover:text-white'
              }`}
            >
              {isMuted ? (
                <>
                  <VolumeX className="h-4 w-4" aria-hidden="true" />
                  <span>{isDe ? 'Stumm' : 'Wyciszony'}</span>
                </>
              ) : (
                <>
                  <Volume2 className="h-4 w-4 text-[#4ADE80]" aria-hidden="true" />
                  <span>{isDe ? 'Mikrofon stumm' : 'Wycisz mikrofon'}</span>
                </>
              )}
            </button>
          )}

          <PWAInstallButton />
        </div>

        {/* Live Audio Input Level */}
        {liveStatus === 'active' && !isMuted && (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#22C55E]/30 bg-[#081A10] px-4 py-2.5 text-xs text-[#86EFAC]">
            <span className="font-semibold">
              {isDe ? 'Assistent hört zu' : 'Asystent aktywnie nasłuchuje'}
            </span>
            <div
              aria-hidden="true"
              className="h-2 w-28 overflow-hidden rounded-full bg-[#12331D]"
            >
              <div
                className="h-full origin-left bg-[#22C55E] transition-transform duration-75"
                style={{ transform: `scaleX(${Math.max(0.08, micLevel)})` }}
              />
            </div>
          </div>
        )}

        {/* Voice Error Alert */}
        {liveStatus === 'error' && liveErrorMessage && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-2xl border border-[#EF4444]/40 bg-[#26090A] px-4 py-3 text-xs leading-relaxed text-[#FCA5A5]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#F87171]" aria-hidden="true" />
            <span>{liveErrorMessage}</span>
          </div>
        )}

        {/* Voice Selector Dropdown */}
        <div
          ref={voiceDropdownRef}
          className="relative flex flex-col gap-2 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="text-xs font-medium text-[#94A3B8]">
            {isDe ? 'Stimme des Assistenten' : 'Wybór głosu asystenta'}
          </span>

          <div className="relative w-full sm:w-96">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={isVoiceMenuOpen}
              onClick={() => setIsVoiceMenuOpen((prev) => !prev)}
              className="flex min-h-[46px] w-full items-center justify-between gap-3 rounded-2xl border border-white/[0.09] bg-[#0B1018] px-3.5 py-2 text-left text-xs text-white transition-colors hover:border-[#22C55E]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22C55E] cursor-pointer"
            >
              <span className="truncate font-semibold">
                {isDe ? activeProfile.labelDe : activeProfile.labelPl}
                <span className="ml-1.5 font-normal text-[#94A3B8]">
                  ·{' '}
                  {activeProfile.gender === 'male'
                    ? isDe
                      ? 'männlich'
                      : 'męski'
                    : isDe
                      ? 'weiblich'
                      : 'damski'}{' '}
                  ({isDe ? activeProfile.styleNoteDe : activeProfile.styleNotePl})
                </span>
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-[#4ADE80] transition-transform duration-150 ${
                  isVoiceMenuOpen ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />
            </button>

            {isVoiceMenuOpen && (
              <div
                role="listbox"
                aria-label={isDe ? 'Stimme auswählen' : 'Lista głosów asystenta'}
                className="absolute left-0 right-0 z-30 mt-1.5 max-h-72 w-full overflow-y-auto rounded-2xl border border-white/[0.1] bg-[#0D131D] p-1.5 shadow-2xl"
              >
                <div className="px-3 py-1.5 text-[11px] font-semibold text-[#94A3B8]">
                  {isDe ? 'Weibliche Stimmen' : 'Głosy kobiece'}
                </div>
                {femaleVoices.map((voice) => {
                  const selected = voiceGender === voice.id;
                  return (
                    <button
                      key={voice.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSelectVoiceGender(voice.id);
                        setIsVoiceMenuOpen(false);
                      }}
                      className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#22C55E] font-semibold text-[#041409]'
                          : 'text-[#E2E8F0] hover:bg-white/[0.06]'
                      }`}
                    >
                      <span className="truncate">
                        {isDe ? voice.labelDe : voice.labelPl}{' '}
                        <span
                          className={
                            selected ? 'font-normal text-[#062E14]' : 'font-normal text-[#94A3B8]'
                          }
                        >
                          · {isDe ? voice.styleNoteDe : voice.styleNotePl}
                        </span>
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                    </button>
                  );
                })}

                <div className="mt-1.5 border-t border-white/[0.07] px-3 pt-2.5 pb-1.5 text-[11px] font-semibold text-[#94A3B8]">
                  {isDe ? 'Männliche Stimmen' : 'Głosy męskie'}
                </div>
                {maleVoices.map((voice) => {
                  const selected = voiceGender === voice.id;
                  return (
                    <button
                      key={voice.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSelectVoiceGender(voice.id);
                        setIsVoiceMenuOpen(false);
                      }}
                      className={`flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#22C55E] font-semibold text-[#041409]'
                          : 'text-[#E2E8F0] hover:bg-white/[0.06]'
                      }`}
                    >
                      <span className="truncate">
                        {isDe ? voice.labelDe : voice.labelPl}{' '}
                        <span
                          className={
                            selected ? 'font-normal text-[#062E14]' : 'font-normal text-[#94A3B8]'
                          }
                        >
                          · {isDe ? voice.styleNoteDe : voice.styleNotePl}
                        </span>
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Story Narration Status (when active) */}
      {(storyStatus === 'loading' || storyStatus === 'playing' || storyStatus === 'paused') && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-2xl border border-[#22C55E]/30 bg-[#081A10] px-4 py-3 text-xs">
          <div className="flex items-center gap-2 text-[#86EFAC]">
            <BookOpen className="h-4 w-4 text-[#4ADE80]" aria-hidden="true" />
            <span className="font-semibold">
              {storyStatus === 'paused'
                ? isDe
                  ? 'Märchen pausiert'
                  : 'Bajka wstrzymana — powiedz „kontynuuj”'
                : storyStatus === 'loading'
                  ? isDe
                    ? 'Lade Märchen...'
                    : 'Przygotowuję płynną narrację bajki...'
                  : isDe
                    ? 'Märchen wird vorgelesen'
                    : 'Opowiadam bajkę od A do Z'}
            </span>
            {storyProgress.total > 0 && (
              <span className="font-mono-tabular text-[11px] text-[#94A3B8]">
                ({Math.min(storyProgress.currentIndex + 1, storyProgress.total)}/{storyProgress.total})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {storyStatus === 'paused' ? (
              <button
                type="button"
                onClick={onResumeStory}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-xl bg-[#22C55E] px-3 text-xs font-semibold text-[#041409] hover:bg-[#4ADE80] cursor-pointer"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{isDe ? 'Weiter' : 'Kontynuuj'}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onPauseStory}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-xl border border-white/[0.09] bg-[#121926] px-3 text-xs font-medium text-[#E2E8F0] hover:border-[#22C55E] cursor-pointer"
              >
                <Pause className="h-3.5 w-3.5" />
                <span>{isDe ? 'Pause' : 'Wstrzymaj'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onStopStory}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-xl border border-[#EF4444]/40 bg-[#26090A] px-3 text-xs font-medium text-[#FCA5A5] hover:bg-[#380E10] cursor-pointer"
            >
              <Square className="h-3.5 w-3.5" />
              <span>{isDe ? 'Stopp' : 'Zakończ'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Inline Video/Screen Share Error */}
      {videoError && (
        <div className="flex shrink-0 items-start gap-2.5 rounded-2xl border border-[#EF4444]/40 bg-[#26090A] px-4 py-3 text-xs text-[#FCA5A5]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#F87171]" aria-hidden="true" />
          <span>{videoError}</span>
        </div>
      )}

      {/* Active Camera / Screen Share Live Preview */}
      {videoMode !== 'none' && (
        <div className="shrink-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0B1018]">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5 text-xs">
            <span className="font-semibold text-[#4ADE80]">{activeVideoLabel}</span>
            <button
              type="button"
              onClick={onStopVideo}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#FCA5A5] hover:text-white cursor-pointer"
            >
              <VideoOff className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{isDe ? 'Bild aus' : 'Wyłącz obraz'}</span>
            </button>
          </div>
          <div className="relative flex max-h-52 w-full items-center justify-center bg-black">
            <video
              ref={videoPreviewRef}
              autoPlay
              muted
              playsInline
              className="max-h-52 w-full object-contain"
            />
          </div>
        </div>
      )}
    </section>
  );
};
