import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { APIProvider } from '@vis.gl/react-google-maps';
import {
  AlarmItem,
  AssistantAction,
  AssistantLanguage,
  BrowserArticleData,
  CameraFacingMode,
  DetachedWindowTab,
  DialTarget,
  ExternalAppLaunch,
  FoodCategory,
  FoodSearchResponse,
  LiveVideoMode,
  NotepadNote,
  PhoneAppTarget,
  ReminderItem,
  StayBookingRecord,
  StayResult,
  StayType,
  StaysSearchResponse,
  TabId,
  TransitMode,
  TransitSearchResponse,
  VOICE_PROFILES,
  VoiceGender,
  WebSearchResponse,
  WebSearchResultItem,
  WhatsappContact,
  YoutubeVideoItem,
  normalizeVoiceId,
} from './types';
import { Header } from './components/Header';
import { VoiceDock } from './components/VoiceDock';
import { ToolsTab } from './components/ToolsTab';
import { FoodTab } from './components/FoodTab';
import { StaysTab } from './components/StaysTab';
import { TransitTab } from './components/TransitTab';
import { DetachedWindowModal } from './components/DetachedWindowModal';
import { AutoBookingModal } from './components/AutoBookingModal';
import { WhatsappModal } from './components/WhatsappModal';
import { BrowserModal } from './components/BrowserModal';
import { DialerModal } from './components/DialerModal';
import { CalculatorModal, evaluateMathExpression } from './components/CalculatorModal';
import { NotepadModal } from './components/NotepadModal';
import { YouTubePlayerPanel } from './components/YouTubePlayerPanel';
import { OfflineIndicator } from './components/OfflineIndicator';
import {
  GoogleFoodSearchFn,
  GooglePlacesFoodBridge,
} from './components/GooglePlacesFoodBridge';
import {
  addDaysToIso,
  buildAndroidAlarmIntentUrl,
  buildWhatsappUrl,
  clampStayDate,
  getAppLaunchInfo,
  getCurrentStayDates,
  sanitizeCodeTokensInQuery,
  sanitizePhoneForTel,
  stripHyphensForCodeOnly,
} from './utils/location';
import {
  computeRmsLevel,
  createCompatAudioContext,
  float32ToPcm16Base64,
  LivePcmPlayer,
  playBase64Wav,
  playGentleChime,
  resampleFloat32,
  StoryPlaybackStatus,
  StoryTtsPlayer,
} from './utils/audio';

const DEFAULT_WHATSAPP_CONTACTS: WhatsappContact[] = [
  { id: 'c1', name: 'Marek Kowalski', phone: '+49 176 23456781', role: 'Kierowca', selected: true, sent: false },
  { id: 'c2', name: 'Anna Nowak', phone: '+49 151 98765432', role: 'Koordynator', selected: true, sent: false },
  { id: 'c3', name: 'Tomasz Zieliński', phone: '+49 172 55543210', role: 'Ekipa', selected: true, sent: false },
  { id: 'c4', name: 'Katarzyna Wiśniewska', phone: '+48 601 234 567', role: 'Rodzina', selected: true, sent: false },
  { id: 'c5', name: 'Piotr Wójcik', phone: '+49 160 77889900', role: 'Biuro', selected: true, sent: false },
];

const CONTACTS_STORAGE_KEY = 'miekiszon_whatsapp_contacts_v1';
const VOICE_GENDER_STORAGE_KEY = 'miekiszon_voice_gender_v1';
const LANGUAGE_STORAGE_KEY = 'miekiszon_language_v1';
const STAY_BOOKINGS_STORAGE_KEY = 'miekiszon_stay_bookings_v1';
const ALARMS_STORAGE_KEY = 'miekiszon_alarms_v1';
const REMINDERS_STORAGE_KEY = 'miekiszon_reminders_v1';
const NOTEPAD_STORAGE_KEY = 'miekiszon_notepad_notes_v1';

function isValidMapsKey(raw?: string | null): string {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed.length < 20) return '';
  if (/MY_GOOGLE_MAPS_API_KEY|YOUR_API_KEY|REPLACE_ME|PLACEHOLDER/i.test(trimmed)) return '';
  return trimmed;
}

function parseFriendlyErrorMessage(raw: unknown, fallback: string): string {
  const msg = String(raw || '').trim();
  if (!msg) return fallback;
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return 'Przekroczono limit zapytań Gemini API (429). Spróbuj ponownie za chwilę lub sprawdź klucz/plan w Settings > Secrets.';
  }
  if (/^\s*\{.*"error"\s*:/.test(msg)) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.error?.message) return String(parsed.error.message);
    } catch {
      // ignore
    }
  }
  return msg;
}

export default function App() {
  const defaultDates = getCurrentStayDates(0, 2);

  // Navigation with previousTab history for returning from detached windows
  const [activeTab, setActiveTab] = useState<TabId>('assistant');
  const [previousTab, setPreviousTab] = useState<TabId | null>(null);

  const [locationInput, setLocationInput] = useState('');
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | undefined>(
    undefined
  );
  const [isGpsLocationActive, setIsGpsLocationActive] = useState(false);
  const gpsLocationLabelRef = useRef<string>('');
  const [isLocating, setIsLocating] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Bilingual language (pl / de) & voice gender (female / male)
  const [language, setLanguage] = useState<AssistantLanguage>(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved === 'de' || saved === 'pl') return saved;
    } catch {
      // ignore
    }
    return 'pl';
  });

  const [voiceGender, setVoiceGender] = useState<VoiceGender>(() => {
    try {
      const saved = localStorage.getItem(VOICE_GENDER_STORAGE_KEY);
      if (saved) return normalizeVoiceId(saved);
    } catch {
      // ignore
    }
    return 'female_kore';
  });

  // Food state
  const [foodCategory, setFoodCategory] = useState<FoodCategory>('all');
  const [foodData, setFoodData] = useState<FoodSearchResponse | null>(null);
  const [isFoodLoading, setIsFoodLoading] = useState(false);
  const [foodError, setFoodError] = useState<string | null>(null);

  // Stays & Auto-booking state
  const [stayType, setStayType] = useState<StayType>('all');
  const [checkIn, setCheckIn] = useState(defaultDates.checkIn);
  const [checkOut, setCheckOut] = useState(defaultDates.checkOut);
  const [guests, setGuests] = useState(2);
  const [staysData, setStaysData] = useState<StaysSearchResponse | null>(null);
  const [isStaysLoading, setIsStaysLoading] = useState(false);
  const [staysError, setStaysError] = useState<string | null>(null);

  const [stayBookings, setStayBookings] = useState<StayBookingRecord[]>(() => {
    try {
      const saved = localStorage.getItem(STAY_BOOKINGS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [autoBookingTarget, setAutoBookingTarget] = useState<StayResult | null>(null);
  const [isAutoBooking, setIsAutoBooking] = useState(false);

  // Transit, Car Route & Fuel state
  const [transitMode, setTransitMode] = useState<TransitMode>('trains');
  const [transitFrom, setTransitFrom] = useState('');
  const [transitTo, setTransitTo] = useState('');
  const [transitData, setTransitData] = useState<TransitSearchResponse | null>(null);
  const [isTransitLoading, setIsTransitLoading] = useState(false);
  const [transitError, setTransitError] = useState<string | null>(null);

  // WhatsApp contacts state (kept for voice-triggered messaging)
  const [whatsappContacts, setWhatsappContacts] = useState<WhatsappContact[]>(() => {
    try {
      const saved = localStorage.getItem(CONTACTS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length >= 5) return parsed;
      }
    } catch {
      // ignore
    }
    return DEFAULT_WHATSAPP_CONTACTS;
  });
  const [whatsappMessage, setWhatsappMessage] = useState(
    'Cześć! Przesyłam aktualne informacje z trasy po Niemczech.'
  );

  // Detached separate window (Stays / Transit) & WhatsApp modal
  const [detachedWindow, setDetachedWindow] = useState<DetachedWindowTab>(null);
  const [isWhatsappModalOpen, setIsWhatsappModalOpen] = useState(false);

  // Dialer, alarms, reminders, notepad, calculator, YouTube & external app launch
  const [dialTarget, setDialTarget] = useState<DialTarget | null>(null);
  const [alarms, setAlarms] = useState<AlarmItem[]>(() => {
    try {
      const saved = localStorage.getItem(ALARMS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [reminders, setReminders] = useState<ReminderItem[]>(() => {
    try {
      const saved = localStorage.getItem(REMINDERS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [notepadNotes, setNotepadNotes] = useState<NotepadNote[]>(() => {
    try {
      const saved = localStorage.getItem(NOTEPAD_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [isNotepadOpen, setIsNotepadOpen] = useState(false);
  const [isCalculatorOpen, setIsCalculatorOpen] = useState(false);
  const [calculatorExpr, setCalculatorExpr] = useState('');

  const [youtubeQuery, setYoutubeQuery] = useState('');
  const [youtubeResults, setYoutubeResults] = useState<YoutubeVideoItem[]>([]);
  const [activeYoutubeVideo, setActiveYoutubeVideo] = useState<YoutubeVideoItem | null>(null);
  const [isYoutubeLoading, setIsYoutubeLoading] = useState(false);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);

  const [storyStatus, setStoryStatus] = useState<StoryPlaybackStatus>('idle');
  const [storyProgress, setStoryProgress] = useState({ currentIndex: 0, total: 0 });
  const storyPlayerRef = useRef<StoryTtsPlayer | null>(null);

  const [lastLaunchedApp, setLastLaunchedApp] = useState<ExternalAppLaunch | null>(null);

  // In-App Voice-Controlled Browser state & history
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [browserQuery, setBrowserQuery] = useState('');
  const [browserData, setBrowserData] = useState<WebSearchResponse | null>(null);
  const [isBrowserLoading, setIsBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browserArticle, setBrowserArticle] = useState<BrowserArticleData | null>(null);
  const [isBrowserArticleLoading, setIsBrowserArticleLoading] = useState(false);
  const browserHistoryRef = useRef<Array<{ query: string; data: WebSearchResponse }>>([]);
  const tabHistoryRef = useRef<TabId[]>([]);

  // Google Maps Platform key & quota state
  const [mapsApiKey, setMapsApiKey] = useState<string>(() =>
    isValidMapsKey(import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)
  );
  const [isGmpQuotaExceeded, setIsGmpQuotaExceeded] = useState(false);

  // Google Places JS SDK food search bridge ref
  const googlePlacesFoodSearchRef = useRef<GoogleFoodSearchFn | null>(null);
  const handleRegisterGoogleFoodSearch = useCallback(
    (fn: GoogleFoodSearchFn | null) => {
      googlePlacesFoodSearchRef.current = fn;
    },
    []
  );

  // Assistant voice state
  const [isMuted, setIsMuted] = useState(false);
  const [liveErrorMessage, setLiveErrorMessage] = useState<string | null>(null);
  const [isSpeakingTts, setIsSpeakingTts] = useState(false);

  // Live API + Camera / Screen Share state
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'connecting' | 'active' | 'error'>(
    'idle'
  );
  const [micLevel, setMicLevel] = useState(0);
  const [videoMode, setVideoMode] = useState<LiveVideoMode>('none');
  const [cameraFacingMode, setCameraFacingMode] = useState<CameraFacingMode>('environment');
  const [videoError, setVideoError] = useState<string | null>(null);

  const liveWsRef = useRef<WebSocket | null>(null);
  const liveMicStreamRef = useRef<MediaStream | null>(null);
  const liveInputCtxRef = useRef<AudioContext | null>(null);
  const liveProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const liveGainRef = useRef<GainNode | null>(null);
  const livePlayerRef = useRef<LivePcmPlayer | null>(null);
  const liveInputBufRef = useRef('');
  const liveOutputBufRef = useRef('');
  const shouldStayLiveRef = useRef(false);
  const liveReconnectTimerRef = useRef<number | null>(null);
  const livePingTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const wsReadyReceivedRef = useRef(false);
  const wsStartupFailuresRef = useRef(0);
  const lastMicUiUpdateRef = useRef(0);
  const voiceTransportRef = useRef<'none' | 'ws' | 'http_speech' | 'http_recorder'>('none');
  const liveWebsocketCapableRef = useRef<boolean | null>(null);
  const speechRecRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recorderTimerRef = useRef<number | null>(null);
  const isProcessingHttpVoiceRef = useRef(false);
  const chunkHadVoiceRef = useRef(false);

  const liveVideoStreamRef = useRef<MediaStream | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const hiddenCaptureVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoCaptureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoFrameIntervalRef = useRef<number | null>(null);

  const activeAudioElRef = useRef<HTMLAudioElement | null>(null);

  // Refs to avoid stale closures
  const locationRef = useRef(locationInput);
  locationRef.current = locationInput;
  const coordinatesRef = useRef(coordinates);
  coordinatesRef.current = coordinates;
  const foodDataRef = useRef(foodData);
  foodDataRef.current = foodData;
  const staysDataRef = useRef(staysData);
  staysDataRef.current = staysData;
  const contactsRef = useRef(whatsappContacts);
  contactsRef.current = whatsappContacts;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const previousTabRef = useRef(previousTab);
  previousTabRef.current = previousTab;
  const detachedWindowRef = useRef(detachedWindow);
  detachedWindowRef.current = detachedWindow;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const isLiveActiveRef = useRef(isLiveActive);
  isLiveActiveRef.current = isLiveActive;
  const liveStatusRef = useRef(liveStatus);
  liveStatusRef.current = liveStatus;
  const voiceGenderRef = useRef(voiceGender);
  voiceGenderRef.current = voiceGender;
  const languageRef = useRef(language);
  languageRef.current = language;
  const videoModeRef = useRef<LiveVideoMode>(videoMode);
  videoModeRef.current = videoMode;
  const cameraFacingRef = useRef<CameraFacingMode>(cameraFacingMode);
  cameraFacingRef.current = cameraFacingMode;
  const alarmsRef = useRef(alarms);
  alarmsRef.current = alarms;
  const remindersRef = useRef(reminders);
  remindersRef.current = reminders;
  const notepadNotesRef = useRef(notepadNotes);
  notepadNotesRef.current = notepadNotes;
  const youtubeResultsRef = useRef(youtubeResults);
  youtubeResultsRef.current = youtubeResults;
  const youtubeQueryRef = useRef(youtubeQuery);
  youtubeQueryRef.current = youtubeQuery;
  const activeYoutubeVideoRef = useRef(activeYoutubeVideo);
  activeYoutubeVideoRef.current = activeYoutubeVideo;
  const isWhatsappModalOpenRef = useRef(isWhatsappModalOpen);
  isWhatsappModalOpenRef.current = isWhatsappModalOpen;
  const dialTargetRef = useRef(dialTarget);
  dialTargetRef.current = dialTarget;
  const autoBookingTargetRef = useRef(autoBookingTarget);
  autoBookingTargetRef.current = autoBookingTarget;
  const isCalculatorOpenRef = useRef(isCalculatorOpen);
  isCalculatorOpenRef.current = isCalculatorOpen;
  const isNotepadOpenRef = useRef(isNotepadOpen);
  isNotepadOpenRef.current = isNotepadOpen;
  const lastLaunchedAppRef = useRef(lastLaunchedApp);
  lastLaunchedAppRef.current = lastLaunchedApp;
  const isBrowserOpenRef = useRef(isBrowserOpen);
  isBrowserOpenRef.current = isBrowserOpen;
  const browserQueryRef = useRef(browserQuery);
  browserQueryRef.current = browserQuery;
  const browserDataRef = useRef(browserData);
  browserDataRef.current = browserData;
  const browserArticleRef = useRef(browserArticle);
  browserArticleRef.current = browserArticle;

  useEffect(() => {
    try {
      localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(whatsappContacts));
    } catch {
      // ignore
    }
  }, [whatsappContacts]);

  useEffect(() => {
    try {
      localStorage.setItem(VOICE_GENDER_STORAGE_KEY, voiceGender);
    } catch {
      // ignore
    }
  }, [voiceGender]);

  useEffect(() => {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // ignore
    }
  }, [language]);

  useEffect(() => {
    try {
      localStorage.setItem(STAY_BOOKINGS_STORAGE_KEY, JSON.stringify(stayBookings.slice(-30)));
    } catch {
      // ignore
    }
  }, [stayBookings]);

  useEffect(() => {
    try {
      localStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(alarms));
    } catch {
      // ignore
    }
  }, [alarms]);

  useEffect(() => {
    try {
      localStorage.setItem(REMINDERS_STORAGE_KEY, JSON.stringify(reminders));
    } catch {
      // ignore
    }
  }, [reminders]);

  useEffect(() => {
    try {
      localStorage.setItem(NOTEPAD_STORAGE_KEY, JSON.stringify(notepadNotes));
    } catch {
      // ignore
    }
  }, [notepadNotes]);

  useEffect(() => {
    const player = new StoryTtsPlayer((st) => {
      setStoryStatus(st.status);
      setStoryProgress({ currentIndex: st.currentIndex, total: st.total });
    });
    storyPlayerRef.current = player;
    return () => {
      player.stop();
      storyPlayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    storyPlayerRef.current?.updateVoiceOrLang(voiceGender, language);
  }, [voiceGender, language]);

  useEffect(() => {
    const handleQuotaExceeded = () => setIsGmpQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    return () => {
      window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    };
  }, []);

  useEffect(() => {
    if (mapsApiKey) return;
    let cancelled = false;
    fetch('/api/config/maps')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const validKey = isValidMapsKey(json?.apiKey ? String(json.apiKey) : '');
        if (!cancelled && validKey) {
          setMapsApiKey(validKey);
        }
      })
      .catch(() => {
        // ignore if unavailable
      });
    return () => {
      cancelled = true;
    };
  }, [mapsApiKey]);

  // Helper to switch active tab while recording full history stack
  const switchTab = useCallback((nextTab: TabId, recordHistory = true) => {
    if (activeTabRef.current !== nextTab) {
      if (recordHistory) {
        tabHistoryRef.current = [...tabHistoryRef.current, activeTabRef.current].slice(-20);
        setPreviousTab(activeTabRef.current);
        previousTabRef.current = activeTabRef.current;
      } else {
        const topPrev = tabHistoryRef.current[tabHistoryRef.current.length - 1] ?? null;
        setPreviousTab(topPrev);
        previousTabRef.current = topPrev;
      }
      setActiveTab(nextTab);
      activeTabRef.current = nextTab;
    }
  }, []);

  // No-op helper kept for compatibility with assistant status callbacks
  const appendChatMessage = useCallback(
    (_role: 'user' | 'assistant', _text: string, _langOverride?: AssistantLanguage) => {},
    []
  );

  // ---------------------------------------------------------------------------
  // TTS Playback (Polish or German, Female Kore or Male Charon)
  // ---------------------------------------------------------------------------
  const speakWithMiekiszon = useCallback(
    async (
      text: string,
      langOverride?: AssistantLanguage,
      forceEvenIfLive = false
    ): Promise<void> => {
      if (
        !text.trim() ||
        isMutedRef.current ||
        (isLiveActiveRef.current && !forceEvenIfLive)
      ) {
        return;
      }
      const targetLang = langOverride || languageRef.current;
      try {
        if (activeAudioElRef.current) {
          activeAudioElRef.current.pause();
          activeAudioElRef.current = null;
        }
        setIsSpeakingTts(true);
        const res = await fetch('/api/assistant/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voiceGender: voiceGenderRef.current,
            language: targetLang,
          }),
        });
        if (!res.ok) throw new Error('TTS request failed');
        const json = await res.json();
        if (json.audioBase64 && !isMutedRef.current) {
          const audio = await playBase64Wav(json.audioBase64);
          activeAudioElRef.current = audio;
          await new Promise<void>((resolve) => {
            const finish = () => {
              setIsSpeakingTts(false);
              resolve();
            };
            audio.onended = finish;
            audio.onerror = finish;
            window.setTimeout(finish, 20000);
          });
        } else {
          setIsSpeakingTts(false);
        }
      } catch {
        // Fallback to browser SpeechSynthesis if server TTS is unavailable
        try {
          if (
            typeof window !== 'undefined' &&
            'speechSynthesis' in window &&
            !isMutedRef.current
          ) {
            window.speechSynthesis.cancel();
            await new Promise<void>((resolve) => {
              const utter = new SpeechSynthesisUtterance(text);
              utter.lang = targetLang === 'de' ? 'de-DE' : 'pl-PL';
              const finish = () => {
                setIsSpeakingTts(false);
                resolve();
              };
              utter.onend = finish;
              utter.onerror = finish;
              window.speechSynthesis.speak(utter);
              window.setTimeout(finish, 12000);
            });
            return;
          }
        } catch {
          // ignore SpeechSynthesis errors
        }
        setIsSpeakingTts(false);
      }
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Alarm & Reminder Ticker
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (alarms.length === 0 && reminders.length === 0) return;

    const timer = window.setInterval(() => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(
        now.getMinutes()
      ).padStart(2, '0')}`;
      const nowMs = now.getTime();

      setAlarms((prev) => {
        let changed = false;
        const next = prev.map((a) => {
          if (a.active && !a.triggered && a.time === hhmm) {
            changed = true;
            playGentleChime();
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification('Budzik Miękiszon', { body: `${a.time} — ${a.label}` });
            }
            const spoken =
              languageRef.current === 'de'
                ? `Wecker klingelt für ${a.time}. ${a.label}.`
                : `Dzwoni budzik na godzinę ${a.time}. ${a.label}.`;
            void speakWithMiekiszon(spoken);
            return { ...a, triggered: true };
          }
          return a;
        });
        return changed ? next : prev;
      });

      setReminders((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          if (!r.triggered && nowMs >= r.triggerAt) {
            changed = true;
            playGentleChime();
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification('Powiadomienie Miękiszon', { body: r.text });
            }
            const spoken =
              languageRef.current === 'de'
                ? `Erinnerung: ${r.text}`
                : `Przypomnienie: ${r.text}`;
            void speakWithMiekiszon(spoken);
            return { ...r, triggered: true };
          }
          return r;
        });
        return changed ? next : prev;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [alarms.length, reminders.length, speakWithMiekiszon]);

  // ---------------------------------------------------------------------------
  // Search & Booking API Calls (Food, Stays, Auto-Book, Transit/Car/Fuel, Web)
  // ---------------------------------------------------------------------------
  const performFoodSearch = useCallback(
    async (
      locOverride?: string,
      catOverride?: FoodCategory,
      coordsOverride?: { lat: number; lng: number } | null,
      countryOverride?: string
    ): Promise<FoodSearchResponse | null> => {
      const rawLoc = locOverride ?? locationRef.current;
      const loc = sanitizeCodeTokensInQuery(rawLoc, countryOverride);
      const locWithCountry =
        countryOverride && loc && !loc.toLowerCase().includes(countryOverride.toLowerCase())
          ? `${loc} ${countryOverride}`.trim()
          : loc;
      const cat = catOverride ?? foodCategory;
      const coords =
        coordsOverride === null
          ? undefined
          : coordsOverride !== undefined
            ? coordsOverride
            : !loc || (gpsLocationLabelRef.current && loc === gpsLocationLabelRef.current)
              ? coordinatesRef.current
              : undefined;
      if (!loc && !coords) return null;

      setIsFoodLoading(true);
      setFoodError(null);
      try {
        // 1. Direct Google Places API (New) via Maps JS SDK (fastest, bypasses Gemini quota)
        if (googlePlacesFoodSearchRef.current) {
          const googleRes = await googlePlacesFoodSearchRef.current({
            location: locWithCountry,
            category: cat,
            coordinates: coords,
            language: languageRef.current,
          });
          if (googleRes && googleRes.results.length > 0) {
            setFoodData(googleRes);
            foodDataRef.current = googleRes;
            return googleRes;
          }
        }

        // 2. Server-side Google Places REST + Gemini Search/Maps grounding fallback
        const res = await fetch('/api/search/food', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: loc,
            country: countryOverride,
            category: cat,
            coordinates: coords,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Błąd wyszukiwania jedzenia.');
        }
        setFoodData(data);
        foodDataRef.current = data;
        return data;
      } catch (err: any) {
        setFoodError(
          parseFriendlyErrorMessage(err?.message, 'Nie udało się wyszukać restauracji.')
        );
        return null;
      } finally {
        setIsFoodLoading(false);
      }
    },
    [foodCategory]
  );

  const performStaysSearch = useCallback(
    async (
      locOverride?: string,
      typeOverride?: StayType,
      coordsOverride?: { lat: number; lng: number } | null,
      checkInOverride?: string,
      checkOutOverride?: string,
      countryOverride?: string,
      minPriceEurOverride?: number | null,
      maxPriceEurOverride?: number | null
    ): Promise<StaysSearchResponse | null> => {
      const loc = sanitizeCodeTokensInQuery(locOverride ?? locationRef.current, countryOverride);
      const st = typeOverride ?? stayType;
      const coords =
        coordsOverride === null
          ? undefined
          : coordsOverride !== undefined
            ? coordsOverride
            : !loc || (gpsLocationLabelRef.current && loc === gpsLocationLabelRef.current)
              ? coordinatesRef.current
              : undefined;
      const validIn = clampStayDate(checkInOverride ?? checkIn);
      const rawOut = clampStayDate(checkOutOverride ?? checkOut, addDaysToIso(validIn, 2));
      const validOut = rawOut <= validIn ? addDaysToIso(validIn, 1) : rawOut;
      if (!loc && !coords) return null;

      setIsStaysLoading(true);
      setStaysError(null);
      try {
        const res = await fetch('/api/search/stays', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: loc,
            country: countryOverride,
            stayType: st,
            checkIn: validIn,
            checkOut: validOut,
            guests,
            minPriceEur: minPriceEurOverride ?? null,
            maxPriceEur: maxPriceEurOverride ?? null,
            coordinates: coords,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Błąd wyszukiwania noclegów.');
        }
        setStaysData(data);
        staysDataRef.current = data;
        return data;
      } catch (err: any) {
        setStaysError(
          parseFriendlyErrorMessage(err?.message, 'Nie udało się wyszukać noclegów.')
        );
        return null;
      } finally {
        setIsStaysLoading(false);
      }
    },
    [stayType, checkIn, checkOut, guests]
  );

  const performAutoBookStay = useCallback(
    async (params: {
      stay?: StayResult;
      location?: string;
      country?: string;
      checkIn?: string;
      checkOut?: string;
      guests?: number;
      guestName?: string;
      guestEmail?: string;
    }) => {
      setIsAutoBooking(true);
      try {
        const res = await fetch('/api/stays/auto-book', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stay: params.stay,
            location: sanitizeCodeTokensInQuery(params.location || locationRef.current, params.country),
            country: params.country,
            checkIn: params.checkIn || checkIn,
            checkOut: params.checkOut || checkOut,
            guests: params.guests || guests,
            guestName: params.guestName || 'Gość Miękiszon',
            guestEmail: params.guestEmail || 'Morfi28@gmx.de',
            coordinates: coordinatesRef.current,
            language: languageRef.current,
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error || 'Błąd automatycznej rezerwacji noclegu.');
        }

        if (json.booking) {
          setStayBookings((prev) => [json.booking, ...prev]);
        }
        setAutoBookingTarget(null);
        switchTab('stays');
        setDetachedWindow('stays');

        if (json.summarySpeech) {
          void speakWithMiekiszon(json.summarySpeech);
        }
        return json;
      } catch (err: any) {
        const errMsg =
          err?.message || 'Nie udało się wykonać automatycznej rezerwacji noclegu.';
        setStaysError(errMsg);
        return null;
      } finally {
        setIsAutoBooking(false);
      }
    },
    [checkIn, checkOut, guests, switchTab, speakWithMiekiszon]
  );

  const performTransitSearch = useCallback(
    async (
      modeOverride?: TransitMode,
      fromOverride?: string,
      toOverride?: string,
      queryOverride?: string,
      countryOverride?: string
    ): Promise<TransitSearchResponse | null> => {
      const m = modeOverride ?? transitMode;
      const fromVal = sanitizeCodeTokensInQuery(
        (fromOverride ?? transitFrom) || locationRef.current,
        countryOverride
      );
      const toVal = sanitizeCodeTokensInQuery(toOverride ?? transitTo, countryOverride);
      const cleanQuery = sanitizeCodeTokensInQuery(queryOverride || '', countryOverride);
      const coords = coordinatesRef.current;

      setIsTransitLoading(true);
      setTransitError(null);
      try {
        const res = await fetch('/api/search/transit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: m,
            from: fromVal,
            to: toVal,
            country: countryOverride,
            query: cleanQuery,
            location: sanitizeCodeTokensInQuery(locationRef.current, countryOverride),
            coordinates: coords,
            language: languageRef.current,
          }),
        });
        const data: TransitSearchResponse = await res.json();
        if (!res.ok) {
          throw new Error((data as any).error || 'Błąd pobierania rozkładu/trasy/cen paliw.');
        }
        setTransitData(data);
        return data;
      } catch (err: any) {
        setTransitError(
          parseFriendlyErrorMessage(err?.message, 'Nie udało się pobrać danych przejazdów.')
        );
        return null;
      } finally {
        setIsTransitLoading(false);
      }
    },
    [transitMode, transitFrom, transitTo]
  );

  // Fast GPS Location Detection
  const detectFastLocation = useCallback(
    (autoSearch = false, manualTrigger = false, transitModeOverride?: TransitMode) => {
      setGpsError(null);
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        if (manualTrigger) {
          setGpsError(
            languageRef.current === 'de'
              ? 'Dieser Browser unterstützt keine GPS-Ortung. Bitte Stadt oder PLZ eingeben.'
              : 'Twoja przeglądarka nie obsługuje funkcji GPS. Wpisz miasto lub kod pocztowy ręcznie.'
          );
        }
        return;
      }
      setIsLocating(true);
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const coords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          };
          setCoordinates(coords);
          coordinatesRef.current = coords;
          setGpsError(null);
          const activeTransitMode = transitModeOverride || transitMode;
          const fallbackLabel = `GPS: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`;

          try {
            const resp = await fetch(
              `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${coords.lat}&lon=${coords.lng}`
            );
            const geo = await resp.json();
            const addr = geo?.address || {};
            const postcode =
              addr.country_code === 'de'
                ? stripHyphensForCodeOnly(addr.postcode || '')
                : addr.postcode || '';
            const resolved = `${addr.road ? `${addr.road}, ` : ''}${postcode} ${
              addr.city || addr.town || addr.village || ''
            }`.trim();

            const finalLabel = resolved || fallbackLabel;
            gpsLocationLabelRef.current = finalLabel;
            setIsGpsLocationActive(true);
            setLocationInput(finalLabel);
            locationRef.current = finalLabel;
            setTransitFrom((prev) => (manualTrigger ? finalLabel : prev || finalLabel));

            if (autoSearch || manualTrigger) {
              const targetLoc = resolved || '';
              if (activeTabRef.current === 'stays') {
                await performStaysSearch(targetLoc, stayType, coords);
              } else if (activeTabRef.current === 'transit') {
                await performTransitSearch(
                  activeTransitMode,
                  targetLoc,
                  activeTransitMode === 'fuel' ? '' : transitTo
                );
              } else if (manualTrigger || activeTabRef.current === 'food') {
                await performFoodSearch(targetLoc, foodCategory, coords);
              }
            }
          } catch {
            gpsLocationLabelRef.current = fallbackLabel;
            setIsGpsLocationActive(true);
            setLocationInput((prev) => prev.trim() || fallbackLabel);
            if (!locationRef.current.trim()) {
              locationRef.current = fallbackLabel;
            }
            if (autoSearch && (manualTrigger || activeTabRef.current === 'food')) {
              if (activeTabRef.current === 'stays') {
                await performStaysSearch('', stayType, coords);
              } else if (activeTabRef.current === 'transit') {
                await performTransitSearch(
                  activeTransitMode,
                  '',
                  activeTransitMode === 'fuel' ? '' : transitTo
                );
              } else if (activeTabRef.current === 'food') {
                await performFoodSearch('', foodCategory, coords);
              }
            }
          } finally {
            setIsLocating(false);
          }
        },
        (geoErr) => {
          setIsLocating(false);
          if (manualTrigger || geoErr?.code === 1) {
            setGpsError(
              geoErr?.code === 1
                ? languageRef.current === 'de'
                  ? 'GPS-Zugriff im Browser blockiert — bitte Standortfreigabe erlauben oder PLZ/Stadt eingeben.'
                  : 'Brak zgody na GPS w przeglądarce — zezwól na lokalizację lub wpisz miasto/kod ręcznie.'
                : languageRef.current === 'de'
                  ? 'GPS-Signal konnte nicht ermittelt werden. Bitte PLZ oder Stadt eingeben.'
                  : 'Nie udało się pobrać sygnału GPS. Sprawdź ustawienia lokalizacji lub wpisz adres ręcznie.'
            );
          }
        },
        {
          enableHighAccuracy: manualTrigger,
          maximumAge: manualTrigger ? 30000 : 300000,
          timeout: 9000,
        }
      );
    },
    [foodCategory, stayType, transitMode, transitTo, performFoodSearch, performStaysSearch, performTransitSearch]
  );

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      navigator.permissions
        .query({ name: 'geolocation' as PermissionName })
        .then((perm) => {
          if (perm.state === 'granted') {
            detectFastLocation(true, false);
          }
        })
        .catch(() => {
          // Wait for user GPS click if permissions query is unsupported
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Android Dialer & App Launcher
  // ---------------------------------------------------------------------------
  const findContactByName = useCallback((nameHint?: string): WhatsappContact | undefined => {
    if (!nameHint) return undefined;
    const lower = nameHint.toLowerCase().trim();
    return contactsRef.current.find(
      (c) =>
        c.name.toLowerCase().includes(lower) ||
        lower.includes(c.name.toLowerCase().split(' ')[0])
    );
  }, []);

  const triggerAndroidDial = useCallback(
    (
      targetHint?: string,
      latestFood?: FoodSearchResponse | null,
      latestStays?: StaysSearchResponse | null
    ) => {
      if (targetHint && targetHint !== 'first') {
        const matchedContact = findContactByName(targetHint);
        if (matchedContact) {
          const telNumber = sanitizePhoneForTel(matchedContact.phone);
          if (telNumber) {
            setDialTarget({
              name: matchedContact.name,
              phone: telNumber,
              address: matchedContact.role,
            });
            try {
              const a = document.createElement('a');
              a.href = `tel:${telNumber}`;
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            } catch {
              // DialerModal fallback
            }
            return true;
          }
        }

        const digitsOnly = targetHint.replace(/[^\d+]/g, '');
        if (digitsOnly.length >= 7) {
          const telNumber = sanitizePhoneForTel(digitsOnly);
          setDialTarget({ name: 'Połączenie telefoniczne', phone: telNumber });
          try {
            const a = document.createElement('a');
            a.href = `tel:${telNumber}`;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } catch {
            // fallback modal
          }
          return true;
        }
      }

      const foodList = (latestFood ?? foodDataRef.current)?.results ?? [];
      const stayList = (latestStays ?? staysDataRef.current)?.results ?? [];
      const pool =
        activeTabRef.current === 'stays'
          ? [...stayList, ...foodList]
          : [...foodList, ...stayList];

      const withPhones = pool.filter((item) => sanitizePhoneForTel(item.phone).length > 4);
      if (withPhones.length === 0) return false;

      let chosen = withPhones[0];
      if (targetHint && targetHint !== 'first') {
        const lower = targetHint.toLowerCase();
        const found = withPhones.find((item) =>
          item.name.toLowerCase().includes(lower)
        );
        if (found) chosen = found;
      }

      const telNumber = sanitizePhoneForTel(chosen.phone);
      if (!telNumber) return false;

      setDialTarget({
        name: chosen.name,
        phone: telNumber,
        address: `${chosen.address}, ${chosen.postalCode} ${chosen.city}`,
      });

      try {
        const a = document.createElement('a');
        a.href = `tel:${telNumber}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch {
        // DialerModal remains visible
      }
      return true;
    },
    [findContactByName]
  );

  const launchExternalApp = useCallback((launch: ExternalAppLaunch) => {
    setLastLaunchedApp(launch);
    try {
      const a = document.createElement('a');
      a.href = launch.url;
      if (!launch.url.startsWith('intent:') && !launch.url.startsWith('tel:')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // Fallback link in VoiceDock
    }
  }, []);

  // Forward declarations via refs so language switching can restart Live cleanly
  const stopLiveSessionRef = useRef<() => void>(() => {});
  const startLiveSessionRef = useRef<
    (gender: VoiceGender, lang: AssistantLanguage) => Promise<void>
  >(async () => {});

  const handleSelectLanguage = useCallback(
    async (nextLang: AssistantLanguage) => {
      setLanguage(nextLang);
      languageRef.current = nextLang;

      if (isLiveActiveRef.current) {
        stopLiveSessionRef.current();
        await startLiveSessionRef.current(voiceGenderRef.current, nextLang);
      }
    },
    []
  );

  // ---------------------------------------------------------------------------
  // In-App Browser & Step-Back Window Navigation Helpers
  // ---------------------------------------------------------------------------
  const performBrowserSearch = useCallback(
    async (rawQuery: string, codeOnly = false, pushHistory = true) => {
      const cleaned = rawQuery.trim();
      if (!cleaned) return;
      if (pushHistory && browserDataRef.current && browserQueryRef.current.trim()) {
        browserHistoryRef.current = [
          ...browserHistoryRef.current,
          { query: browserQueryRef.current, data: browserDataRef.current },
        ].slice(-12);
      }
      setIsBrowserOpen(true);
      isBrowserOpenRef.current = true;
      setBrowserQuery(cleaned);
      browserQueryRef.current = cleaned;
      setBrowserArticle(null);
      browserArticleRef.current = null;
      setBrowserError(null);
      setIsBrowserLoading(true);
      try {
        const res = await fetch('/api/search/web', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: cleaned,
            language: languageRef.current,
            codeOnly,
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json?.error || 'Nie udało się wyszukać w przeglądarce.');
        }
        setBrowserData(json);
        browserDataRef.current = json;
      } catch (err: any) {
        setBrowserError(
          parseFriendlyErrorMessage(err?.message, 'Błąd wyszukiwania w przeglądarce.')
        );
      } finally {
        setIsBrowserLoading(false);
      }
    },
    []
  );

  const performOpenBrowserArticle = useCallback(
    async (item: WebSearchResultItem, readAloud = false) => {
      const targetUrl = (item.websiteUrl || '').trim();
      if (!/^https?:\/\//i.test(targetUrl)) return;
      setIsBrowserOpen(true);
      isBrowserOpenRef.current = true;
      setBrowserError(null);
      setIsBrowserArticleLoading(true);
      try {
        const res = await fetch('/api/browser/article', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: targetUrl,
            title: item.title,
            language: languageRef.current,
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json?.error || 'Nie udało się otworzyć strony w przeglądarce.');
        }
        const articleObj: BrowserArticleData = {
          url: json.url || targetUrl,
          title: json.title || item.title,
          domain: json.domain || 'Web',
          content: json.content || item.summary || '',
        };
        setBrowserArticle(articleObj);
        browserArticleRef.current = articleObj;
        if (readAloud && articleObj.content) {
          void speakWithMiekiszon(articleObj.content.slice(0, 750));
        }
      } catch (err: any) {
        setBrowserError(
          parseFriendlyErrorMessage(err?.message, 'Nie udało się pobrać artykułu.')
        );
      } finally {
        setIsBrowserArticleLoading(false);
      }
    },
    [speakWithMiekiszon]
  );

  const performGoBack = useCallback(
    (steps = 1) => {
      const count = Math.max(1, Math.min(steps, 10));
      for (let i = 0; i < count; i++) {
        if (isBrowserOpenRef.current) {
          if (browserArticleRef.current) {
            setBrowserArticle(null);
            browserArticleRef.current = null;
            continue;
          }
          if (browserHistoryRef.current.length > 0) {
            const prevEntry = browserHistoryRef.current.pop()!;
            setBrowserQuery(prevEntry.query);
            browserQueryRef.current = prevEntry.query;
            setBrowserData(prevEntry.data);
            browserDataRef.current = prevEntry.data;
            setBrowserError(null);
            continue;
          }
          setIsBrowserOpen(false);
          isBrowserOpenRef.current = false;
          continue;
        }

        if (isWhatsappModalOpenRef.current) {
          setIsWhatsappModalOpen(false);
          isWhatsappModalOpenRef.current = false;
          continue;
        }
        if (dialTargetRef.current) {
          setDialTarget(null);
          dialTargetRef.current = null;
          continue;
        }
        if (autoBookingTargetRef.current) {
          setAutoBookingTarget(null);
          autoBookingTargetRef.current = null;
          continue;
        }
        if (isCalculatorOpenRef.current) {
          setIsCalculatorOpen(false);
          isCalculatorOpenRef.current = false;
          continue;
        }
        if (isNotepadOpenRef.current) {
          setIsNotepadOpen(false);
          isNotepadOpenRef.current = false;
          continue;
        }
        if (lastLaunchedAppRef.current) {
          setLastLaunchedApp(null);
          lastLaunchedAppRef.current = null;
          continue;
        }
        if (detachedWindowRef.current) {
          setDetachedWindow(null);
          detachedWindowRef.current = null;
          if (tabHistoryRef.current.length > 0) {
            const prevTab = tabHistoryRef.current.pop()!;
            switchTab(prevTab, false);
          } else if (activeTabRef.current !== 'assistant') {
            switchTab('assistant', false);
          }
          continue;
        }
        if (tabHistoryRef.current.length > 0) {
          const prevTab = tabHistoryRef.current.pop()!;
          switchTab(prevTab, false);
          continue;
        }
        if (activeTabRef.current !== 'assistant') {
          switchTab('assistant', false);
        }
      }
    },
    [switchTab]
  );

  // ---------------------------------------------------------------------------
  // Multi-Step Action Executor
  // ---------------------------------------------------------------------------
  const executeActions = useCallback(
    async (actions: AssistantAction[]): Promise<boolean> => {
      let latestFood = foodDataRef.current;
      let latestStays = staysDataRef.current;
      let handledOwnSpeech = false;

      for (const action of actions) {
        if (action.type === 'go_back') {
          performGoBack(action.steps || 1);
        } else if (action.type === 'close_tab') {
          const validTabs: TabId[] = ['assistant', 'food', 'stays', 'transit', 'tools'];
          if (!action.targetTab) {
            if (
              isBrowserOpenRef.current ||
              isWhatsappModalOpenRef.current ||
              dialTargetRef.current ||
              autoBookingTargetRef.current ||
              isCalculatorOpenRef.current ||
              isNotepadOpenRef.current ||
              lastLaunchedAppRef.current ||
              detachedWindowRef.current
            ) {
              performGoBack(1);
              continue;
            }
          }
          if (action.targetTab && validTabs.includes(action.targetTab)) {
            setDetachedWindow(null);
            detachedWindowRef.current = null;
            switchTab(action.targetTab);
          } else {
            performGoBack(1);
          }
        } else if (action.type === 'navigate' && action.tab) {
          const validTabs: TabId[] = ['assistant', 'food', 'stays', 'transit', 'tools'];
          const targetTab: TabId = validTabs.includes(action.tab)
            ? action.tab
            : 'assistant';
          // Stay in the user's current window (Jedzenie/Noclegi/Przejazdy) unless user explicitly asked to switch back
          if (
            targetTab === 'assistant' &&
            activeTabRef.current !== 'assistant' &&
            action.explicit !== true
          ) {
            continue;
          }
          switchTab(targetTab);
          if (targetTab === 'stays' || targetTab === 'transit') {
            setDetachedWindow(targetTab);
          } else {
            setDetachedWindow(null);
          }
        } else if (action.type === 'set_language') {
          handledOwnSpeech = true;
          await handleSelectLanguage(action.language);
        } else if (action.type === 'search_food') {
          setDetachedWindow(null);
          switchTab('food');
          const actionLoc =
            action.location?.trim() ||
            (action as { target?: string; to?: string; query?: string }).target?.trim() ||
            (action as { to?: string }).to?.trim() ||
            (action as { query?: string }).query?.trim();
          const rawNextLoc = actionLoc || locationRef.current;
          const nextLoc = sanitizeCodeTokensInQuery(rawNextLoc, action.country);
          if (actionLoc) {
            setIsGpsLocationActive(false);
            setLocationInput(nextLoc);
            locationRef.current = nextLoc;
          }
          const cat: FoodCategory = action.category || 'all';
          setFoodCategory(cat);
          latestFood = await performFoodSearch(
            nextLoc,
            cat,
            actionLoc ? null : coordinatesRef.current,
            action.country
          );
        } else if (action.type === 'search_stays') {
          switchTab('stays');
          setDetachedWindow('stays');
          const actionLoc =
            action.location?.trim() ||
            (action as { target?: string; to?: string; query?: string }).target?.trim() ||
            (action as { to?: string }).to?.trim() ||
            (action as { query?: string }).query?.trim();
          const rawNextLoc = actionLoc || locationRef.current;
          const nextLoc = sanitizeCodeTokensInQuery(rawNextLoc, action.country);
          if (actionLoc) {
            setLocationInput(nextLoc);
            locationRef.current = nextLoc;
          }
          const st: StayType = action.stayType || 'all';
          setStayType(st);
          latestStays = await performStaysSearch(
            nextLoc,
            st,
            coordinatesRef.current,
            undefined,
            undefined,
            action.country,
            typeof action.minPriceEur === 'number' ? action.minPriceEur : null,
            typeof action.maxPriceEur === 'number' ? action.maxPriceEur : null
          );
        } else if (action.type === 'auto_book_stay') {
          handledOwnSpeech = true;
          if (action.checkIn) setCheckIn(action.checkIn);
          if (action.checkOut) setCheckOut(action.checkOut);
          if (action.guests) setGuests(action.guests);

          const stayCandidate = action.stayName
            ? staysDataRef.current?.results.find((s) =>
                s.name.toLowerCase().includes(action.stayName!.toLowerCase())
              )
            : undefined;
          const actionLoc =
            action.location?.trim() ||
            (action as { target?: string; to?: string; query?: string }).target?.trim() ||
            (action as { to?: string }).to?.trim() ||
            (action as { query?: string }).query?.trim();

          await performAutoBookStay({
            stay: stayCandidate,
            location: actionLoc || locationRef.current,
            country: action.country,
            checkIn: action.checkIn || checkIn,
            checkOut: action.checkOut || checkOut,
            guests: action.guests || guests,
          });
        } else if (action.type === 'search_transit') {
          switchTab('transit');
          setDetachedWindow('transit');
          const m = action.mode || 'trains';
          setTransitMode(m);
          const nextFrom = action.from
            ? sanitizeCodeTokensInQuery(action.from, action.country)
            : action.from;
          const nextTo = action.to
            ? sanitizeCodeTokensInQuery(action.to, action.country)
            : action.to;
          if (nextFrom) setTransitFrom(nextFrom);
          if (nextTo) setTransitTo(nextTo);
          const transitRes = await performTransitSearch(
            m,
            nextFrom,
            nextTo,
            action.query,
            action.country
          );
          if (transitRes?.summarySpeech) {
            handledOwnSpeech = true;
            void speakWithMiekiszon(transitRes.summarySpeech);
          }
        } else if (action.type === 'web_search') {
          if (action.query) {
            await performBrowserSearch(action.query, Boolean(action.codeOnly), true);
          }
          if (action.autoRedirect && action.query) {
            launchExternalApp(getAppLaunchInfo('chrome', action.query));
          }
        } else if (action.type === 'dial') {
          triggerAndroidDial(action.target, latestFood, latestStays);
        } else if (action.type === 'prepare_whatsapp') {
          if (action.action === 'close') {
            setIsWhatsappModalOpen(false);
            if (lastLaunchedAppRef.current?.appLabel === 'WhatsApp') {
              setLastLaunchedApp(null);
            }
            continue;
          }
          if (action.action === 'reset') {
            setWhatsappContacts((prev) => prev.map((c) => ({ ...c, sent: false })));
            setIsWhatsappModalOpen(true);
            continue;
          }
          if (action.action === 'select_all') {
            setWhatsappContacts((prev) => prev.map((c) => ({ ...c, selected: true })));
            setIsWhatsappModalOpen(true);
            continue;
          }

          const rawMsg = action.message || (action as { text?: string }).text;
          const msgToSend = rawMsg || whatsappMessage;
          if (rawMsg) {
            setWhatsappMessage(rawMsg);
          }

          const filterVal = (
            action.recipientFilter ||
            (action as { contactName?: string; to?: string; target?: string }).contactName ||
            (action as { to?: string }).to ||
            (action as { target?: string }).target ||
            ''
          ).trim();
          const phoneDigits = sanitizePhoneForTel(action.phone || filterVal);
          const matched =
            filterVal && filterVal.toLowerCase() !== 'all'
              ? findContactByName(filterVal)
              : undefined;
          const fallbackContact =
            !matched && phoneDigits.length < 8 && (action.sendNow || action.action === 'send')
              ? contactsRef.current.find(
                  (c) => c.selected && !c.sent && sanitizePhoneForTel(c.phone).length >= 8
                ) ||
                contactsRef.current.find(
                  (c) => c.selected && sanitizePhoneForTel(c.phone).length >= 8
                )
              : undefined;

          const resolvedContact = matched || fallbackContact;
          const targetPhone = resolvedContact?.phone || (phoneDigits.length >= 8 ? phoneDigits : '');
          const shouldSendNow =
            Boolean(targetPhone) &&
            (Boolean(action.sendNow) ||
              action.action === 'send' ||
              Boolean(matched) ||
              phoneDigits.length >= 8);

          if (shouldSendNow && targetPhone) {
            const waUrl = buildWhatsappUrl(targetPhone, msgToSend);
            launchExternalApp({
              title: `WhatsApp: ${resolvedContact?.name || targetPhone}`,
              url: waUrl,
              appLabel: 'WhatsApp',
            });
            if (resolvedContact) {
              setWhatsappContacts((prev) =>
                prev.map((c) => (c.id === resolvedContact.id ? { ...c, sent: true } : c))
              );
            }
            if (action.autoClose !== false) {
              setIsWhatsappModalOpen(false);
              window.setTimeout(() => {
                setLastLaunchedApp((prev) =>
                  prev && prev.url === waUrl ? null : prev
                );
              }, 3500);
            } else {
              setIsWhatsappModalOpen(true);
            }
          } else {
            setIsWhatsappModalOpen(true);
          }
        } else if (action.type === 'close_whatsapp') {
          setIsWhatsappModalOpen(false);
          if (lastLaunchedAppRef.current?.appLabel === 'WhatsApp') {
            setLastLaunchedApp(null);
          }
        } else if (action.type === 'read_story') {
          handledOwnSpeech = true;
          if (activeAudioElRef.current) {
            activeAudioElRef.current.pause();
            activeAudioElRef.current = null;
          }
          livePlayerRef.current?.interrupt();
          try {
            const storyRes = await fetch('/api/assistant/story', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                topic: action.topic || '',
                language: languageRef.current,
              }),
            });
            const storyJson = await storyRes.json();
            if (storyJson.storyText) {
              if (!isMutedRef.current && storyPlayerRef.current) {
                void storyPlayerRef.current.startStory(
                  storyJson.storyText,
                  voiceGenderRef.current,
                  languageRef.current
                );
              }
            }
          } catch {
            // keep running
          }
        } else if (action.type === 'continue_story') {
          handledOwnSpeech = true;
          livePlayerRef.current?.interrupt();
          const resumed = await storyPlayerRef.current?.resume();
          if (!resumed) {
            void executeActions([{ type: 'read_story' }]);
          }
        } else if (action.type === 'pause_story') {
          handledOwnSpeech = true;
          storyPlayerRef.current?.pause();
        } else if (action.type === 'set_alarm') {
          const cleanTime = action.time || '07:00';
          const cleanLabel = action.label || 'Budzik';
          if ('Notification' in window && Notification.permission === 'default') {
            void Notification.requestPermission();
          }
          setAlarms((prev) => [
            ...prev,
            {
              id: `alarm_${Date.now()}`,
              time: cleanTime,
              label: cleanLabel,
              active: true,
            },
          ]);
          if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')) {
            const alarmUrl = buildAndroidAlarmIntentUrl(cleanTime, cleanLabel);
            launchExternalApp({
              title: `Budzik ${cleanTime} (${cleanLabel})`,
              url: alarmUrl,
              appLabel: 'Zegar Android',
            });
          }
        } else if (action.type === 'delete_alarm') {
          const curAlarms = alarmsRef.current;
          if (action.all) {
            setAlarms([]);
          } else if (action.time || action.label) {
            setAlarms((prev) =>
              prev.filter((a) => {
                const matchTime = action.time ? a.time === action.time : false;
                const matchLabel = action.label
                  ? a.label.toLowerCase().includes(action.label.toLowerCase())
                  : false;
                return !(matchTime || matchLabel);
              })
            );
          } else if (curAlarms.length > 0) {
            setAlarms((prev) => prev.slice(0, -1));
          }
        } else if (action.type === 'set_reminder') {
          if ('Notification' in window && Notification.permission === 'default') {
            void Notification.requestPermission();
          }
          let triggerMs = Date.now() + (action.delayMinutes || 5) * 60000;
          if (action.time && /^\d{1,2}:\d{2}$/.test(action.time)) {
            const [h, m] = action.time.split(':').map(Number);
            const target = new Date();
            target.setHours(h, m, 0, 0);
            if (target.getTime() <= Date.now()) {
              target.setDate(target.getDate() + 1);
            }
            triggerMs = target.getTime();
          }
          const d = new Date(triggerMs);
          const displayTime = `${String(d.getHours()).padStart(2, '0')}:${String(
            d.getMinutes()
          ).padStart(2, '0')}`;
          setReminders((prev) => [
            ...prev,
            {
              id: `rem_${Date.now()}`,
              text: action.text || 'Powiadomienie Miękiszon',
              triggerAt: triggerMs,
              displayTime,
            },
          ]);
        } else if (action.type === 'delete_reminder') {
          const curReminders = remindersRef.current;
          if (action.all) {
            setReminders([]);
          } else if (action.text) {
            const needle = action.text.toLowerCase();
            setReminders((prev) => prev.filter((r) => !r.text.toLowerCase().includes(needle)));
          } else if (curReminders.length > 0) {
            setReminders((prev) => prev.slice(0, -1));
          }
        } else if (action.type === 'open_youtube') {
          handledOwnSpeech = true;
          const q = (action.query || '').trim();
          setIsYoutubeLoading(true);
          setYoutubeError(null);
          setYoutubeQuery(q || (languageRef.current === 'de' ? 'Musik Hits' : 'Polskie hity'));
          try {
            const ytRes = await fetch('/api/youtube/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: q, language: languageRef.current }),
            });
            const ytJson = await ytRes.json();
            if (!ytRes.ok) {
              throw new Error(ytJson.error || 'Nie udało się pobrać wyników YouTube.');
            }
            const vids: YoutubeVideoItem[] = Array.isArray(ytJson.results) ? ytJson.results : [];
            setYoutubeResults(vids);
            youtubeResultsRef.current = vids;

            if (vids.length > 0) {
              let pickedIdx = 0;
              if (action.trackIndex) {
                pickedIdx = Math.min(Math.max(1, action.trackIndex) - 1, vids.length - 1);
              } else if (action.randomTrack && vids.length > 1) {
                pickedIdx = Math.floor(Math.random() * vids.length);
              }
              const picked = vids[pickedIdx];
              setActiveYoutubeVideo(picked);
              activeYoutubeVideoRef.current = picked;
              const msg = action.trackIndex
                ? languageRef.current === 'de'
                  ? `Ich spiele Titel Nr. ${pickedIdx + 1} auf YouTube: ${picked.title}`
                  : `Odtwarzam utwór nr ${pickedIdx + 1} na YouTube: ${picked.title}`
                : action.randomTrack
                  ? languageRef.current === 'de'
                    ? `YouTube für ${q || 'dich'} geöffnet — spiele verfügbaren Titel Nr. ${pickedIdx + 1}: ${picked.title}`
                    : `Włączyłem YouTube${q ? ` dla ${q}` : ''}. Puszczam dostępny kawałek nr ${pickedIdx + 1}: ${picked.title}`
                  : languageRef.current === 'de'
                    ? `YouTube geöffnet: ${picked.title}`
                    : `Włączyłem YouTube. Wybrano utwór nr 1: ${picked.title}`;
              void speakWithMiekiszon(msg);
            } else {
              const targetApp = action.service === 'youtube_music' ? 'youtube_music' : 'youtube';
              launchExternalApp(getAppLaunchInfo(targetApp, action.query));
            }
          } catch (ytErr: any) {
            setYoutubeError(ytErr?.message || 'Błąd wyszukiwania YouTube.');
            const targetApp = action.service === 'youtube_music' ? 'youtube_music' : 'youtube';
            launchExternalApp(getAppLaunchInfo(targetApp, action.query));
          } finally {
            setIsYoutubeLoading(false);
          }
        } else if (action.type === 'select_youtube_track') {
          handledOwnSpeech = true;
          let vids = youtubeResultsRef.current;
          if (vids.length === 0) {
            setIsYoutubeLoading(true);
            try {
              const ytRes = await fetch('/api/youtube/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  query: youtubeQueryRef.current || '',
                  language: languageRef.current,
                }),
              });
              const ytJson = await ytRes.json();
              if (ytRes.ok && Array.isArray(ytJson.results)) {
                vids = ytJson.results;
                setYoutubeResults(vids);
                youtubeResultsRef.current = vids;
              }
            } catch {
              // ignore
            } finally {
              setIsYoutubeLoading(false);
            }
          }
          if (vids.length > 0) {
            let pickedIdx = 0;
            if (action.randomTrack || action.nextTrack) {
              const curId = activeYoutubeVideoRef.current?.videoId;
              const otherIndices = vids
                .map((v, i) => (v.videoId !== curId ? i : -1))
                .filter((i) => i >= 0);
              if (otherIndices.length > 0) {
                pickedIdx = otherIndices[Math.floor(Math.random() * otherIndices.length)];
              } else {
                pickedIdx = 0;
              }
            } else {
              const requestedIdx = Math.max(1, action.trackIndex || 1);
              pickedIdx = Math.min(requestedIdx - 1, vids.length - 1);
            }
            const picked = vids[pickedIdx];
            setActiveYoutubeVideo(picked);
            activeYoutubeVideoRef.current = picked;
            const msg =
              languageRef.current === 'de'
                ? `Ich spiele Titel Nummer ${pickedIdx + 1}: ${picked.title}`
                : `Odtwarzam utwór numer ${pickedIdx + 1}: ${picked.title}`;
            void speakWithMiekiszon(msg);
          }
        } else if (action.type === 'close_youtube') {
          setActiveYoutubeVideo(null);
          activeYoutubeVideoRef.current = null;
          setYoutubeResults([]);
          youtubeResultsRef.current = [];
          setYoutubeError(null);
        } else if (action.type === 'open_browser') {
          setIsBrowserOpen(true);
          isBrowserOpenRef.current = true;
          if (action.openExternalChrome) {
            launchExternalApp(getAppLaunchInfo('chrome', action.query));
          }
          if (action.query) {
            await performBrowserSearch(action.query, Boolean(action.codeOnly), true);
          } else if (action.url && /^https?:\/\//i.test(action.url)) {
            await performOpenBrowserArticle(
              {
                id: 'direct_url',
                title: action.url,
                kind: 'website',
                categoryLabel: 'Web',
                summary: '',
                address: null,
                phone: null,
                websiteUrl: action.url,
                mapsUrl: null,
                directionsUrl: null,
              },
              false
            );
          }
        } else if (action.type === 'select_article') {
          const items = browserDataRef.current?.results ?? [];
          if (items.length > 0) {
            let picked: WebSearchResultItem | undefined;
            if (action.titleQuery) {
              const needle = action.titleQuery.toLowerCase();
              picked = items.find((r) => r.title.toLowerCase().includes(needle));
            }
            if (!picked) {
              const idx = Math.min(
                Math.max(1, action.articleIndex || 1) - 1,
                items.length - 1
              );
              picked = items[idx];
            }
            if (picked) {
              await performOpenBrowserArticle(picked, Boolean(action.readAloud));
            }
          }
        } else if (action.type === 'close_article') {
          setBrowserArticle(null);
          browserArticleRef.current = null;
        } else if (action.type === 'close_browser') {
          setIsBrowserOpen(false);
          isBrowserOpenRef.current = false;
          setBrowserArticle(null);
          browserArticleRef.current = null;
          setIsBrowserLoading(false);
          if (
            lastLaunchedAppRef.current?.appLabel === 'Google Chrome' ||
            lastLaunchedAppRef.current?.appLabel === 'Przeglądarka'
          ) {
            setLastLaunchedApp(null);
            lastLaunchedAppRef.current = null;
          }
        } else if (action.type === 'open_calculator') {
          setIsCalculatorOpen(true);
          if (action.expression) {
            setCalculatorExpr(action.expression);
            const resStr = evaluateMathExpression(action.expression);
            if (resStr) {
              handledOwnSpeech = true;
              const calcMsg =
                languageRef.current === 'de'
                  ? `Ergebnis von ${action.expression} ist ${resStr}.`
                  : `Wynik działania ${action.expression} to ${resStr}.`;
              void speakWithMiekiszon(calcMsg);
            }
          }
        } else if (action.type === 'close_calculator') {
          setIsCalculatorOpen(false);
        } else if (action.type === 'open_notepad') {
          setIsNotepadOpen(true);
        } else if (action.type === 'write_note') {
          const text = (action.text || '').trim();
          if (text) {
            const newNote: NotepadNote = {
              id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
              text,
              createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            };
            setNotepadNotes((prev) => [newNote, ...prev]);
          }
          setIsNotepadOpen(true);
        } else if (action.type === 'delete_note') {
          if (action.all) {
            setNotepadNotes([]);
          } else if (action.text) {
            const needle = action.text.toLowerCase();
            setNotepadNotes((prev) => prev.filter((n) => !n.text.toLowerCase().includes(needle)));
          } else if (notepadNotesRef.current.length > 0) {
            setNotepadNotes((prev) => prev.slice(1));
          }
        } else if (action.type === 'close_notepad') {
          setIsNotepadOpen(false);
        } else if (action.type === 'open_app') {
          if (action.app === 'calculator') {
            setIsCalculatorOpen(true);
          } else if (action.app === 'notepad') {
            setIsNotepadOpen(true);
          } else if (action.app === 'whatsapp' && !action.contactName && !action.query) {
            setIsWhatsappModalOpen(true);
          } else {
            const contact = findContactByName(action.contactName);
            const launch = getAppLaunchInfo(
              action.app,
              action.query || contact?.name,
              contact?.phone
            );
            launchExternalApp(launch);
          }
        } else if (action.type === 'close_app') {
          const targetApp = action.app || 'all';
          if (targetApp === 'all' || targetApp === 'whatsapp') {
            setIsWhatsappModalOpen(false);
          }
          if (targetApp === 'all' || targetApp === 'phone') {
            setDialTarget(null);
          }
          if (targetApp === 'all' || targetApp === 'booking') {
            setAutoBookingTarget(null);
          }
          if (targetApp === 'all' || targetApp === 'calculator') {
            setIsCalculatorOpen(false);
          }
          if (targetApp === 'all' || targetApp === 'notepad') {
            setIsNotepadOpen(false);
          }
          if (targetApp === 'all' || targetApp === 'browser' || targetApp === 'chrome') {
            setIsBrowserOpen(false);
            isBrowserOpenRef.current = false;
            setBrowserArticle(null);
            browserArticleRef.current = null;
            setIsBrowserLoading(false);
          }
          if (targetApp === 'all' || targetApp === 'youtube' || targetApp === 'youtube_music') {
            setActiveYoutubeVideo(null);
            activeYoutubeVideoRef.current = null;
            setYoutubeResults([]);
            youtubeResultsRef.current = [];
            setYoutubeError(null);
          }
          if (targetApp === 'all') {
            setDetachedWindow(null);
            setLastLaunchedApp(null);
          } else {
            const labelByApp: Partial<Record<PhoneAppTarget, string>> = {
              whatsapp: 'WhatsApp',
              chrome: 'Google Chrome',
              browser: 'Google Chrome',
              youtube: 'YouTube',
              youtube_music: 'YouTube Music',
              maps: 'Mapy Google',
              spotify: 'Spotify',
              booking: 'Booking.com',
              calendar: 'Kalendarz',
              clock: 'Zegar Android',
              phone: 'Telefon',
            };
            const targetLabel = labelByApp[targetApp];
            if (!targetLabel || lastLaunchedAppRef.current?.appLabel === targetLabel) {
              setLastLaunchedApp(null);
            }
          }
        }
      }
      return handledOwnSpeech;
    },
    [
      switchTab,
      handleSelectLanguage,
      performFoodSearch,
      performStaysSearch,
      performAutoBookStay,
      performTransitSearch,
      performBrowserSearch,
      performOpenBrowserArticle,
      performGoBack,
      triggerAndroidDial,
      speakWithMiekiszon,
      launchExternalApp,
      findContactByName,
      whatsappMessage,
      checkIn,
      checkOut,
      guests,
    ]
  );

  // ---------------------------------------------------------------------------
  // Live Video Share (Rear/Front Camera + Phone Screen Share)
  // ---------------------------------------------------------------------------
  const stopVideoShare = useCallback(() => {
    if (videoFrameIntervalRef.current !== null) {
      window.clearInterval(videoFrameIntervalRef.current);
      videoFrameIntervalRef.current = null;
    }
    if (liveVideoStreamRef.current) {
      liveVideoStreamRef.current.getTracks().forEach((t) => t.stop());
      liveVideoStreamRef.current = null;
    }
    if (hiddenCaptureVideoRef.current) {
      hiddenCaptureVideoRef.current.srcObject = null;
    }
    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = null;
    }
    setVideoMode('none');
    videoModeRef.current = 'none';
  }, []);

  const attachStreamToVideoElements = useCallback((stream: MediaStream) => {
    if (!hiddenCaptureVideoRef.current) {
      const hiddenVid = document.createElement('video');
      hiddenVid.muted = true;
      hiddenVid.playsInline = true;
      hiddenCaptureVideoRef.current = hiddenVid;
    }
    hiddenCaptureVideoRef.current.srcObject = stream;
    void hiddenCaptureVideoRef.current.play().catch(() => {});

    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = stream;
      void videoPreviewRef.current.play().catch(() => {});
    }
  }, []);

  const startVideoFrameLoop = useCallback(() => {
    if (videoFrameIntervalRef.current !== null) {
      window.clearInterval(videoFrameIntervalRef.current);
    }
    videoFrameIntervalRef.current = window.setInterval(() => {
      const ws = liveWsRef.current;
      const vid = hiddenCaptureVideoRef.current || videoPreviewRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !vid) return;
      if (vid.readyState < 2 || vid.videoWidth === 0 || vid.videoHeight === 0) return;

      const maxDim = 768;
      const scale = Math.min(1, maxDim / Math.max(vid.videoWidth, vid.videoHeight));
      const targetW = Math.max(1, Math.round(vid.videoWidth * scale));
      const targetH = Math.max(1, Math.round(vid.videoHeight * scale));

      let canvas = videoCaptureCanvasRef.current;
      if (!canvas) {
        canvas = document.createElement('canvas');
        videoCaptureCanvasRef.current = canvas;
      }
      canvas.width = targetW;
      canvas.height = targetH;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(vid, 0, 0, targetW, targetH);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      const base64Jpeg = dataUrl.split(',')[1];
      if (base64Jpeg) {
        ws.send(JSON.stringify({ video: base64Jpeg }));
      }
    }, 1000);
  }, []);

  useEffect(() => {
    if (videoMode !== 'none' && liveVideoStreamRef.current && videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = liveVideoStreamRef.current;
      void videoPreviewRef.current.play().catch(() => {});
    }
  }, [videoMode, activeTab]);

  // ---------------------------------------------------------------------------
  // Gemini Live API Real-Time Voice Session (Persistent until user turns off)
  // ---------------------------------------------------------------------------
  const stopLiveSession = useCallback(
    (preserveVideo = false, keepAliveForReconnect = false) => {
      if (liveReconnectTimerRef.current !== null) {
        window.clearTimeout(liveReconnectTimerRef.current);
        liveReconnectTimerRef.current = null;
      }
      if (livePingTimerRef.current !== null) {
        window.clearInterval(livePingTimerRef.current);
        livePingTimerRef.current = null;
      }
      if (!keepAliveForReconnect) {
        shouldStayLiveRef.current = false;
      }

      if (liveInputBufRef.current.trim()) {
        appendChatMessage('user', liveInputBufRef.current);
        liveInputBufRef.current = '';
      }
      if (liveOutputBufRef.current.trim()) {
        appendChatMessage('assistant', liveOutputBufRef.current);
        liveOutputBufRef.current = '';
      }

      if (liveWsRef.current) {
        const oldWs = liveWsRef.current;
        liveWsRef.current = null;
        oldWs.onopen = null;
        oldWs.onmessage = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        try {
          oldWs.close(1000, 'client_stop');
        } catch {
          // ignore
        }
      }

      if (speechRecRef.current) {
        const oldRec = speechRecRef.current;
        speechRecRef.current = null;
        oldRec.onresult = null;
        oldRec.onerror = null;
        oldRec.onend = null;
        try {
          oldRec.stop();
        } catch {
          // ignore
        }
      }
      if (recorderTimerRef.current !== null) {
        window.clearTimeout(recorderTimerRef.current);
        recorderTimerRef.current = null;
      }
      if (mediaRecorderRef.current) {
        const oldMr = mediaRecorderRef.current;
        mediaRecorderRef.current = null;
        try {
          if (oldMr.state !== 'inactive') oldMr.stop();
        } catch {
          // ignore
        }
      }
      if (!keepAliveForReconnect) {
        voiceTransportRef.current = 'none';
        isProcessingHttpVoiceRef.current = false;
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          try {
            window.speechSynthesis.cancel();
          } catch {
            // ignore
          }
        }
        if (liveProcessorRef.current) {
          liveProcessorRef.current.disconnect();
          liveProcessorRef.current = null;
        }
        if (liveGainRef.current) {
          liveGainRef.current.disconnect();
          liveGainRef.current = null;
        }
        if (liveInputCtxRef.current && liveInputCtxRef.current.state !== 'closed') {
          void liveInputCtxRef.current.close();
          liveInputCtxRef.current = null;
        }
        if (liveMicStreamRef.current) {
          liveMicStreamRef.current.getTracks().forEach((t) => t.stop());
          liveMicStreamRef.current = null;
        }
        if (livePlayerRef.current) {
          livePlayerRef.current.dispose();
          livePlayerRef.current = null;
        }
        if (!preserveVideo) {
          stopVideoShare();
        }
        setMicLevel(0);
        setIsLiveActive(false);
        isLiveActiveRef.current = false;
        setLiveStatus('idle');
        liveStatusRef.current = 'idle';
      }
    },
    [appendChatMessage, stopVideoShare]
  );

  stopLiveSessionRef.current = () => stopLiveSession(false, false);

  const handleToggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      isMutedRef.current = next;
      if (next && activeAudioElRef.current) {
        activeAudioElRef.current.pause();
        activeAudioElRef.current = null;
        setIsSpeakingTts(false);
      }
      if (livePlayerRef.current) {
        livePlayerRef.current.setMuted(next);
      }
      if (liveMicStreamRef.current) {
        liveMicStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = !next;
        });
      }
      return next;
    });
  }, []);

  const startLiveSessionWithOptions = useCallback(
    async (gender: VoiceGender, lang: AssistantLanguage, isAutoReconnect = false) => {
      shouldStayLiveRef.current = true;
      if (liveReconnectTimerRef.current !== null) {
        window.clearTimeout(liveReconnectTimerRef.current);
        liveReconnectTimerRef.current = null;
      }
      if (activeAudioElRef.current) {
        activeAudioElRef.current.pause();
        activeAudioElRef.current = null;
        setIsSpeakingTts(false);
      }

      if (!isAutoReconnect) {
        wsStartupFailuresRef.current = 0;
        setLiveErrorMessage(null);
        setLiveStatus('connecting');
        liveStatusRef.current = 'connecting';
      }

      // IMPORTANT for iOS Safari / Android Chrome: initialize & resume Web Audio
      // contexts synchronously BEFORE any `await` so the user gesture token is preserved.
      try {
        let player = livePlayerRef.current;
        if (!player) {
          player = new LivePcmPlayer();
          livePlayerRef.current = player;
        }
        player.setMuted(isMutedRef.current);
        player.unlock();

        if (!liveInputCtxRef.current || liveInputCtxRef.current.state === 'closed') {
          liveInputCtxRef.current = createCompatAudioContext();
        }
        if (liveInputCtxRef.current.state === 'suspended') {
          void liveInputCtxRef.current.resume();
        }
      } catch (audioInitErr) {
        console.warn('Pre-await AudioContext unlock failed:', audioInitErr);
      }

      try {
        if (
          typeof navigator === 'undefined' ||
          !navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== 'function'
        ) {
          shouldStayLiveRef.current = false;
          stopLiveSession(false, false);
          setLiveStatus('error');
          liveStatusRef.current = 'error';
          setLiveErrorMessage(
            lang === 'de'
              ? 'Mikrofonzugriff wird von diesem Browser/Kontext blockiert (bitte direkt über HTTPS in Chrome oder Safari öffnen).'
              : 'Przeglądarka blokuje mikrofon (otwórz aplikację bezpośrednio po HTTPS w Google Chrome lub Safari i zezwól na mikrofon).'
          );
          return;
        }

        // Reuse existing live mic stream when reconnecting seamlessly
        const existingTracks = liveMicStreamRef.current?.getAudioTracks() ?? [];
        const hasHealthyMic = existingTracks.some((t) => t.readyState === 'live');
        let stream = liveMicStreamRef.current;

        if (!stream || !hasHealthyMic) {
          if (stream) {
            stream.getTracks().forEach((t) => t.stop());
          }
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          liveMicStreamRef.current = stream;
          const [audioTrack] = stream.getAudioTracks();
          if (audioTrack) {
            audioTrack.onended = () => {
              if (shouldStayLiveRef.current) {
                stopLiveSession(true, true);
                liveReconnectTimerRef.current = window.setTimeout(() => {
                  if (shouldStayLiveRef.current) {
                    void startLiveSessionWithOptions(
                      voiceGenderRef.current,
                      languageRef.current,
                      true
                    );
                  }
                }, 400);
              }
            };
          }
        }

        stream.getAudioTracks().forEach((t) => {
          t.enabled = !isMutedRef.current;
        });

        let player = livePlayerRef.current;
        if (!player) {
          player = new LivePcmPlayer();
          livePlayerRef.current = player;
        }
        player.setMuted(isMutedRef.current);
        player.unlock();

        let inputCtx = liveInputCtxRef.current;
        if (!inputCtx || inputCtx.state === 'closed') {
          inputCtx = createCompatAudioContext();
          liveInputCtxRef.current = inputCtx;
        }
        if (inputCtx.state === 'suspended') {
          await inputCtx.resume();
        }

        if (!liveProcessorRef.current || !hasHealthyMic) {
          if (liveProcessorRef.current) {
            liveProcessorRef.current.disconnect();
          }
          if (liveGainRef.current) {
            liveGainRef.current.disconnect();
          }
          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          const silentGain = inputCtx.createGain();
          silentGain.gain.value = 0;

          liveProcessorRef.current = processor;
          liveGainRef.current = silentGain;

          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(inputCtx.destination);

          processor.onaudioprocess = (e) => {
            const rawChannel = e.inputBuffer.getChannelData(0);
            const rms = computeRmsLevel(rawChannel);
            if (rms > 0.03) {
              chunkHadVoiceRef.current = true;
            }
            const nowMs = Date.now();
            if (nowMs - lastMicUiUpdateRef.current >= 140) {
              lastMicUiUpdateRef.current = nowMs;
              setMicLevel(rms);
            }
            const activeWs = liveWsRef.current;
            if (
              activeWs &&
              activeWs.readyState === WebSocket.OPEN &&
              activeWs.bufferedAmount < 65536 &&
              !isMutedRef.current
            ) {
              const ctxRate = liveInputCtxRef.current?.sampleRate || 48000;
              const resampled = resampleFloat32(rawChannel, ctxRate, 16000);
              const base64 = float32ToPcm16Base64(resampled);
              activeWs.send(JSON.stringify({ audio: base64 }));
            }
          };
        }

        const runHttpVoiceCommand = async (spokenText: string) => {
          const clean = spokenText.trim();
          if (!clean || !shouldStayLiveRef.current) return;
          isProcessingHttpVoiceRef.current = true;
          try {
            const visibleItems = [
              ...(foodDataRef.current?.results ?? []).slice(0, 5),
              ...(staysDataRef.current?.results ?? []).slice(0, 5),
            ].map((item) => ({ name: item.name, phone: item.phone }));
            const res = await fetch('/api/assistant/command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                transcript: clean,
                currentTab: activeTabRef.current,
                currentLocation: locationRef.current,
                visibleItems,
                contacts: contactsRef.current.slice(0, 12).map((c) => ({
                  name: c.name,
                  phone: c.phone,
                })),
                voiceGender: voiceGenderRef.current,
                language: languageRef.current,
              }),
            });
            if (!res.ok) return;
            const json = await res.json();
            const actions = Array.isArray(json.actions) ? json.actions : [];
            const handledOwnSpeech = await executeActions(actions);
            if (!handledOwnSpeech && json.replyText && shouldStayLiveRef.current) {
              await speakWithMiekiszon(json.replyText, languageRef.current, true);
            }
          } catch {
            // ignore transient command failure and keep listening
          } finally {
            isProcessingHttpVoiceRef.current = false;
          }
        };

        const startBrowserVoiceFallbackSession = async (targetLang: AssistantLanguage) => {
          if (!shouldStayLiveRef.current) return;
          if (liveWsRef.current) {
            const staleWs = liveWsRef.current;
            liveWsRef.current = null;
            staleWs.onopen = null;
            staleWs.onmessage = null;
            staleWs.onerror = null;
            staleWs.onclose = null;
            try {
              staleWs.close(1000, 'fallback_http');
            } catch {
              // ignore
            }
          }

          const SpeechRecognitionCtor =
            (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any })
              .SpeechRecognition ||
            (window as unknown as { webkitSpeechRecognition?: any }).webkitSpeechRecognition;

          if (SpeechRecognitionCtor) {
            voiceTransportRef.current = 'http_speech';
            setLiveErrorMessage(null);
            setIsLiveActive(true);
            isLiveActiveRef.current = true;
            setLiveStatus('active');
            liveStatusRef.current = 'active';

            const launchRec = () => {
              if (!shouldStayLiveRef.current || voiceTransportRef.current !== 'http_speech') return;
              const rec = new SpeechRecognitionCtor();
              rec.lang = targetLang === 'de' ? 'de-DE' : 'pl-PL';
              rec.continuous = true;
              rec.interimResults = false;
              rec.maxAlternatives = 1;
              speechRecRef.current = rec;

              rec.onresult = (evt: any) => {
                if (isMutedRef.current || isProcessingHttpVoiceRef.current) return;
                let finalText = '';
                for (let i = evt.resultIndex; i < evt.results.length; i++) {
                  if (evt.results[i].isFinal) {
                    finalText += ` ${evt.results[i][0]?.transcript || ''}`;
                  }
                }
                const cleaned = finalText.trim();
                if (!cleaned) return;
                try {
                  rec.stop();
                } catch {
                  // ignore
                }
                void runHttpVoiceCommand(cleaned).finally(() => {
                  if (shouldStayLiveRef.current && voiceTransportRef.current === 'http_speech') {
                    window.setTimeout(launchRec, 250);
                  }
                });
              };

              rec.onerror = (evt: any) => {
                if (evt?.error === 'not-allowed' || evt?.error === 'service-not-allowed') {
                  shouldStayLiveRef.current = false;
                  stopLiveSession(false, false);
                  setLiveStatus('error');
                  liveStatusRef.current = 'error';
                  setLiveErrorMessage(
                    targetLang === 'de'
                      ? 'Mikrofonzugriff wurde blockiert. Bitte Berechtigung im Browser erlauben.'
                      : 'Brak zgody na mikrofon — zezwól na mikrofon w ustawieniach przeglądarki.'
                  );
                }
              };

              rec.onend = () => {
                if (
                  shouldStayLiveRef.current &&
                  voiceTransportRef.current === 'http_speech' &&
                  !isProcessingHttpVoiceRef.current
                ) {
                  window.setTimeout(launchRec, 300);
                }
              };

              try {
                rec.start();
              } catch {
                // ignore duplicate start
              }
            };

            launchRec();
            return;
          }

          // MediaRecorder fallback for browsers without Web Speech API (e.g. Firefox)
          if (typeof MediaRecorder !== 'undefined' && stream) {
            voiceTransportRef.current = 'http_recorder';
            setLiveErrorMessage(null);
            setIsLiveActive(true);
            isLiveActiveRef.current = true;
            setLiveStatus('active');
            liveStatusRef.current = 'active';

            const recordNextSegment = () => {
              if (!shouldStayLiveRef.current || voiceTransportRef.current !== 'http_recorder') {
                return;
              }
              if (isMutedRef.current || isProcessingHttpVoiceRef.current) {
                recorderTimerRef.current = window.setTimeout(recordNextSegment, 500);
                return;
              }
              const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                  ? 'audio/webm'
                  : '';
              const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
              mediaRecorderRef.current = mr;
              const chunks: BlobPart[] = [];
              chunkHadVoiceRef.current = false;

              mr.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0) chunks.push(ev.data);
              };

              mr.onstop = async () => {
                const hadVoice = chunkHadVoiceRef.current;
                if (
                  hadVoice &&
                  chunks.length > 0 &&
                  shouldStayLiveRef.current &&
                  !isMutedRef.current
                ) {
                  try {
                    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
                    const base64Audio = await new Promise<string>((resolve) => {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const result = String(reader.result || '');
                        resolve(result.includes(',') ? result.split(',')[1] : '');
                      };
                      reader.readAsDataURL(blob);
                    });
                    if (base64Audio) {
                      const trRes = await fetch('/api/assistant/transcribe', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          audioBase64: base64Audio,
                          mimeType: mr.mimeType || 'audio/webm',
                          language: targetLang,
                        }),
                      });
                      if (trRes.ok) {
                        const trJson = await trRes.json();
                        if (trJson?.text?.trim()) {
                          await runHttpVoiceCommand(trJson.text.trim());
                        }
                      }
                    }
                  } catch {
                    // ignore transient transcription error
                  }
                }
                if (shouldStayLiveRef.current && voiceTransportRef.current === 'http_recorder') {
                  recordNextSegment();
                }
              };

              try {
                mr.start();
                recorderTimerRef.current = window.setTimeout(() => {
                  try {
                    if (mr.state === 'recording') mr.stop();
                  } catch {
                    // ignore
                  }
                }, 4000);
              } catch {
                // ignore
              }
            };

            recordNextSegment();
            return;
          }

          shouldStayLiveRef.current = false;
          stopLiveSession(false, false);
          setLiveStatus('error');
          liveStatusRef.current = 'error';
          setLiveErrorMessage(
            targetLang === 'de'
              ? 'Spracherkennung wird von diesem Browser nicht unterstützt.'
              : 'Ta przeglądarka nie obsługuje rozpoznawania mowy.'
          );
        };

        // Detect serverless runtime (e.g. Vercel) where /api/live WebSocket upgrade is unavailable
        if (liveWebsocketCapableRef.current === null) {
          try {
            const ctrl = new AbortController();
            const tid = window.setTimeout(() => ctrl.abort(), 2500);
            const healthRes = await fetch('/api/health', {
              cache: 'no-store',
              signal: ctrl.signal,
            });
            window.clearTimeout(tid);
            if (healthRes.ok) {
              const healthJson = await healthRes.json();
              liveWebsocketCapableRef.current = healthJson?.liveWebsocket !== false;
            }
          } catch {
            // proceed with WebSocket attempt + fallback
          }
        }

        if (liveWebsocketCapableRef.current === false) {
          await startBrowserVoiceFallbackSession(lang);
          return;
        }

        // Close any stale WS before creating fresh one
        if (liveWsRef.current) {
          const staleWs = liveWsRef.current;
          liveWsRef.current = null;
          staleWs.onopen = null;
          staleWs.onmessage = null;
          staleWs.onerror = null;
          staleWs.onclose = null;
          try {
            staleWs.close(1000, 'replace');
          } catch {
            // ignore
          }
        }

        voiceTransportRef.current = 'ws';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsReadyReceivedRef.current = false;
        const ws = new WebSocket(
          `${protocol}//${window.location.host}/api/live?voice=${gender}&lang=${lang}`
        );
        liveWsRef.current = ws;

        const scheduleAutoReconnect = (failureReason?: string) => {
          if (!shouldStayLiveRef.current) {
            stopLiveSession(false, false);
            return;
          }
          if (!wsReadyReceivedRef.current) {
            wsStartupFailuresRef.current += 1;
            if (wsStartupFailuresRef.current >= 1) {
              liveWebsocketCapableRef.current = false;
              void startBrowserVoiceFallbackSession(languageRef.current);
              return;
            }
          }
          if (liveReconnectTimerRef.current !== null) return;
          stopLiveSession(true, true);
          const attempt = reconnectAttemptRef.current;
          reconnectAttemptRef.current = Math.min(attempt + 1, 5);
          const delayMs = Math.min(2500, 450 + attempt * 400);
          liveReconnectTimerRef.current = window.setTimeout(() => {
            liveReconnectTimerRef.current = null;
            if (shouldStayLiveRef.current) {
              void startLiveSessionWithOptions(
                voiceGenderRef.current,
                languageRef.current,
                true
              );
            }
          }, delayMs);
        };

        ws.onopen = () => {
          if (livePingTimerRef.current !== null) {
            window.clearInterval(livePingTimerRef.current);
          }
          livePingTimerRef.current = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'ping' }));
              } catch {
                // ignore
              }
            }
            if (liveInputCtxRef.current?.state === 'suspended') {
              void liveInputCtxRef.current.resume();
            }
            livePlayerRef.current?.resumeIfNeeded();
          }, 12000);
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') {
            return;
          }
          if (msg.type === 'ready') {
            wsReadyReceivedRef.current = true;
            wsStartupFailuresRef.current = 0;
            reconnectAttemptRef.current = 0;
            setLiveErrorMessage(null);
            setIsLiveActive(true);
            isLiveActiveRef.current = true;
            setLiveStatus('active');
            liveStatusRef.current = 'active';
            liveInputBufRef.current = '';
            liveOutputBufRef.current = '';
          } else if (msg.type === 'audio' && msg.audio) {
            livePlayerRef.current?.enqueuePcmBase64(msg.audio);
          } else if (msg.type === 'interrupted') {
            livePlayerRef.current?.interrupt();
            storyPlayerRef.current?.pause();
          } else if (msg.type === 'input_transcript' && msg.text) {
            const st = storyPlayerRef.current?.getStatus();
            if (st === 'playing' || st === 'loading') {
              const lowerChunk = String(msg.text).toLowerCase();
              if (!/(kontynuuj|czytaj dalej|mów dalej)/.test(lowerChunk)) {
                storyPlayerRef.current?.pause();
              }
            }
            liveInputBufRef.current = liveInputBufRef.current
              ? `${liveInputBufRef.current} ${msg.text}`
              : msg.text;
          } else if (msg.type === 'output_transcript' && msg.text) {
            liveOutputBufRef.current = `${liveOutputBufRef.current}${msg.text}`;
          } else if (msg.type === 'turn_complete') {
            if (liveInputBufRef.current.trim()) {
              appendChatMessage('user', liveInputBufRef.current, lang);
              liveInputBufRef.current = '';
            }
            if (liveOutputBufRef.current.trim()) {
              appendChatMessage('assistant', liveOutputBufRef.current, lang);
              liveOutputBufRef.current = '';
            }
          } else if (msg.type === 'tool_action') {
            const { name, args } = msg;
            if (name === 'navigateToTab') {
              void executeActions([{ type: 'navigate', tab: args.tab, explicit: true }]);
            } else if (name === 'goBackWindow') {
              void executeActions([
                { type: 'go_back', ...(args.steps ? { steps: Number(args.steps) } : {}) },
              ]);
            } else if (name === 'closeOrReturnTab') {
              void executeActions([{ type: 'close_tab', targetTab: args.targetTab }]);
            } else if (name === 'setAssistantLanguage') {
              void executeActions([{ type: 'set_language', language: args.language }]);
            } else if (name === 'searchFoodGermany') {
              void executeActions([
                {
                  type: 'search_food',
                  location: args.location,
                  country: args.country,
                  category: args.category || 'all',
                },
              ]);
            } else if (name === 'searchStaysGermany') {
              void executeActions([
                {
                  type: 'search_stays',
                  location: args.location,
                  country: args.country,
                  stayType: args.stayType || 'all',
                  ...(args.minPriceEur ? { minPriceEur: Number(args.minPriceEur) } : {}),
                  ...(args.maxPriceEur ? { maxPriceEur: Number(args.maxPriceEur) } : {}),
                },
              ]);
            } else if (name === 'autoBookStay') {
              void executeActions([
                {
                  type: 'auto_book_stay',
                  location: args.location,
                  country: args.country,
                  stayName: args.stayName,
                  checkIn: args.checkIn,
                  checkOut: args.checkOut,
                  guests: args.guests,
                },
              ]);
            } else if (name === 'checkTransitOrFuel') {
              void executeActions([
                {
                  type: 'search_transit',
                  mode: args.mode || 'trains',
                  from: args.from,
                  to: args.to,
                  country: args.country,
                  query: args.query,
                },
              ]);
            } else if (name === 'searchWebAndPlaces') {
              void executeActions([
                {
                  type: 'web_search',
                  query: args.query,
                  autoRedirect: Boolean(args.autoRedirect),
                  codeOnly: Boolean(args.codeOnly),
                },
              ]);
            } else if (name === 'dialPhoneNumber') {
              void executeActions([{ type: 'dial', target: args.target || 'first' }]);
            } else if (name === 'prepareWhatsappMessage') {
              void executeActions([
                {
                  type: 'prepare_whatsapp',
                  action: args.action,
                  message: args.message,
                  recipientFilter: args.recipientFilter,
                  phone: args.phone,
                  sendNow: args.sendNow !== undefined ? Boolean(args.sendNow) : undefined,
                  autoClose: args.autoClose !== undefined ? Boolean(args.autoClose) : true,
                },
              ]);
            } else if (name === 'setAlarm') {
              void executeActions([
                { type: 'set_alarm', time: args.time, label: args.label },
              ]);
            } else if (name === 'deleteAlarm') {
              void executeActions([
                {
                  type: 'delete_alarm',
                  time: args.time,
                  label: args.label,
                  all: Boolean(args.all),
                },
              ]);
            } else if (name === 'setReminder') {
              void executeActions([
                {
                  type: 'set_reminder',
                  delayMinutes: args.delayMinutes,
                  time: args.time,
                  text: args.text,
                },
              ]);
            } else if (name === 'deleteReminder') {
              void executeActions([
                {
                  type: 'delete_reminder',
                  text: args.text,
                  all: Boolean(args.all),
                },
              ]);
            } else if (name === 'tellOrContinueStory') {
              if (args.action === 'continue') {
                void executeActions([{ type: 'continue_story' }]);
              } else if (args.action === 'pause') {
                void executeActions([{ type: 'pause_story' }]);
              } else {
                void executeActions([{ type: 'read_story', topic: args.topic }]);
              }
            } else if (name === 'openYouTubeMusic') {
              void executeActions([
                {
                  type: 'open_youtube',
                  service: args.service === 'youtube' ? 'youtube' : 'youtube_music',
                  query: args.query,
                  ...(args.trackIndex ? { trackIndex: Number(args.trackIndex) } : {}),
                  ...(args.randomTrack ? { randomTrack: Boolean(args.randomTrack) } : {}),
                },
              ]);
            } else if (name === 'selectYouTubeTrack') {
              void executeActions([
                {
                  type: 'select_youtube_track',
                  ...(args.trackIndex ? { trackIndex: Number(args.trackIndex) } : {}),
                  ...(args.randomTrack ? { randomTrack: Boolean(args.randomTrack) } : {}),
                  ...(args.nextTrack ? { nextTrack: Boolean(args.nextTrack) } : {}),
                },
              ]);
            } else if (name === 'closeYouTube') {
              void executeActions([{ type: 'close_youtube' }]);
            } else if (name === 'openBrowser') {
              void executeActions([
                {
                  type: 'open_browser',
                  query: args.query,
                  openExternalChrome: Boolean(args.openExternalChrome),
                },
              ]);
            } else if (name === 'selectBrowserArticle') {
              void executeActions([
                {
                  type: 'select_article',
                  articleIndex: Number(args.articleIndex) || 1,
                  readAloud: Boolean(args.readAloud),
                },
              ]);
            } else if (name === 'closeArticle') {
              void executeActions([{ type: 'close_article' }]);
            } else if (name === 'closeBrowser') {
              void executeActions([{ type: 'close_browser' }]);
            } else if (name === 'manageCalculator') {
              if (args.action === 'close') {
                void executeActions([{ type: 'close_calculator' }]);
              } else {
                void executeActions([
                  { type: 'open_calculator', expression: args.expression },
                ]);
              }
            } else if (name === 'manageNotepad') {
              if (args.action === 'close') {
                void executeActions([{ type: 'close_notepad' }]);
              } else if (args.action === 'delete') {
                void executeActions([
                  { type: 'delete_note', text: args.text, all: Boolean(args.all) },
                ]);
              } else if (args.action === 'write' && args.text) {
                void executeActions([{ type: 'write_note', text: args.text }]);
              } else {
                void executeActions([{ type: 'open_notepad' }]);
              }
            } else if (name === 'openPhoneApp') {
              void executeActions([
                {
                  type: 'open_app',
                  app: args.app,
                  query: args.query,
                  contactName: args.contactName,
                },
              ]);
            } else if (name === 'closePhoneApp') {
              void executeActions([
                {
                  type: 'close_app',
                  app: args.app || 'all',
                },
              ]);
            }
          } else if (msg.type === 'reconnect_needed' || msg.type === 'closed') {
            scheduleAutoReconnect();
          } else if (msg.type === 'error') {
            if (shouldStayLiveRef.current) {
              scheduleAutoReconnect(msg.message);
            } else {
              setLiveErrorMessage(msg.message || 'Błąd połączenia głosowego na żywo.');
              stopLiveSession(false, false);
              setLiveStatus('error');
              liveStatusRef.current = 'error';
            }
          }
        };

        ws.onerror = () => {
          scheduleAutoReconnect();
        };

        ws.onclose = () => {
          if (shouldStayLiveRef.current) {
            scheduleAutoReconnect();
          } else {
            stopLiveSession(false, false);
          }
        };
      } catch (err: any) {
        if (
          err?.name === 'NotAllowedError' ||
          err?.name === 'NotFoundError' ||
          err?.name === 'SecurityError' ||
          err?.name === 'TypeError'
        ) {
          shouldStayLiveRef.current = false;
          setLiveErrorMessage(
            err?.name === 'NotFoundError'
              ? 'Nie wykryto mikrofonu na tym urządzeniu.'
              : 'Nie udało się uruchomić mikrofonu do rozmowy na żywo. Sprawdź uprawnienia mikrofonu w przeglądarce.'
          );
          stopLiveSession(false, false);
          setLiveStatus('error');
          liveStatusRef.current = 'error';
        } else if (shouldStayLiveRef.current) {
          wsStartupFailuresRef.current += 1;
          if (wsStartupFailuresRef.current >= 3) {
            shouldStayLiveRef.current = false;
            stopLiveSession(false, false);
            setLiveStatus('error');
            liveStatusRef.current = 'error';
            setLiveErrorMessage(
              err?.message ||
                'Nie udało się uruchomić sesji głosowej. Sprawdź połączenie z internetem i mikrofon.'
            );
            return;
          }
          const attempt = reconnectAttemptRef.current;
          reconnectAttemptRef.current = Math.min(attempt + 1, 5);
          liveReconnectTimerRef.current = window.setTimeout(() => {
            liveReconnectTimerRef.current = null;
            if (shouldStayLiveRef.current) {
              void startLiveSessionWithOptions(
                voiceGenderRef.current,
                languageRef.current,
                true
              );
            }
          }, 1000);
        } else {
          stopLiveSession(false, false);
          setLiveStatus('error');
          liveStatusRef.current = 'error';
        }
      }
    },
    [appendChatMessage, executeActions, speakWithMiekiszon, stopLiveSession]
  );

  useEffect(() => {
    const handleWakeup = () => {
      if (!shouldStayLiveRef.current) return;
      if (liveInputCtxRef.current?.state === 'suspended') {
        void liveInputCtxRef.current.resume();
      }
      livePlayerRef.current?.resumeIfNeeded();
      if (voiceTransportRef.current !== 'ws') return;
      const ws = liveWsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        void startLiveSessionWithOptions(voiceGenderRef.current, languageRef.current, true);
      }
    };
    document.addEventListener('visibilitychange', handleWakeup);
    window.addEventListener('online', handleWakeup);
    return () => {
      document.removeEventListener('visibilitychange', handleWakeup);
      window.removeEventListener('online', handleWakeup);
    };
  }, [startLiveSessionWithOptions]);

  startLiveSessionRef.current = async (gender: VoiceGender, lang: AssistantLanguage) => {
    stopLiveSession(true, true);
    await startLiveSessionWithOptions(gender, lang, false);
  };

  const acquireCameraStream = useCallback(
    async (facing: CameraFacingMode) => {
      setVideoError(null);
      if (!navigator.mediaDevices?.getUserMedia) {
        setVideoError('Twoja przeglądarka nie obsługuje dostępu do kamery.');
        return;
      }
      try {
        if (liveVideoStreamRef.current) {
          liveVideoStreamRef.current.getTracks().forEach((t) => t.stop());
          liveVideoStreamRef.current = null;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        const [videoTrack] = stream.getVideoTracks();
        if (videoTrack) {
          videoTrack.onended = () => stopVideoShare();
        }
        liveVideoStreamRef.current = stream;
        attachStreamToVideoElements(stream);
        setCameraFacingMode(facing);
        cameraFacingRef.current = facing;
        setVideoMode('camera');
        videoModeRef.current = 'camera';
        startVideoFrameLoop();

        if (!isLiveActiveRef.current && liveStatusRef.current !== 'connecting') {
          await startLiveSessionWithOptions(voiceGenderRef.current, languageRef.current);
        }
      } catch (err: any) {
        setVideoError(
          err?.name === 'NotAllowedError'
            ? 'Odmówiono dostępu do kamery w przeglądarce.'
            : 'Nie udało się uruchomić wybranej kamery.'
        );
      }
    },
    [attachStreamToVideoElements, startLiveSessionWithOptions, startVideoFrameLoop, stopVideoShare]
  );

  const handleToggleCamera = useCallback(async () => {
    if (videoModeRef.current === 'camera') {
      stopVideoShare();
      return;
    }
    await acquireCameraStream(cameraFacingRef.current);
  }, [acquireCameraStream, stopVideoShare]);

  const handleSwitchCameraFacing = useCallback(async () => {
    const nextFacing: CameraFacingMode =
      cameraFacingRef.current === 'environment' ? 'user' : 'environment';
    await acquireCameraStream(nextFacing);
  }, [acquireCameraStream]);

  const handleToggleScreenShare = useCallback(async () => {
    if (videoModeRef.current === 'screen') {
      stopVideoShare();
      return;
    }
    setVideoError(null);
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setVideoError(
        'Udostępnianie ekranu nie jest wspierane w tej przeglądarce mobilnej (użyj Chrome / Safari lub kamery).'
      );
      return;
    }
    try {
      if (liveVideoStreamRef.current) {
        liveVideoStreamRef.current.getTracks().forEach((t) => t.stop());
        liveVideoStreamRef.current = null;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
      const [screenTrack] = stream.getVideoTracks();
      if (screenTrack) {
        screenTrack.onended = () => stopVideoShare();
      }
      liveVideoStreamRef.current = stream;
      attachStreamToVideoElements(stream);
      setVideoMode('screen');
      videoModeRef.current = 'screen';
      startVideoFrameLoop();

      if (!isLiveActiveRef.current && liveStatusRef.current !== 'connecting') {
        await startLiveSessionWithOptions(voiceGenderRef.current, languageRef.current);
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setVideoError(
          err?.name === 'NotAllowedError'
            ? 'Przerwano lub odmówiono udostępniania ekranu.'
            : 'Nie udało się udostępnić ekranu na tym urządzeniu.'
        );
      }
    }
  }, [attachStreamToVideoElements, startLiveSessionWithOptions, startVideoFrameLoop, stopVideoShare]);

  const handleToggleLive = useCallback(async () => {
    if (isLiveActive || liveStatus === 'connecting' || shouldStayLiveRef.current) {
      shouldStayLiveRef.current = false;
      stopLiveSession(false, false);
      return;
    }
    await startLiveSessionWithOptions(voiceGenderRef.current, languageRef.current);
  }, [isLiveActive, liveStatus, stopLiveSession, startLiveSessionWithOptions]);

  const handleSelectVoiceGender = useCallback(
    async (gender: VoiceGender) => {
      setVoiceGender(gender);
      voiceGenderRef.current = gender;
      if (isLiveActive || shouldStayLiveRef.current) {
        stopLiveSession(true, true);
        await startLiveSessionWithOptions(gender, languageRef.current, false);
      }
    },
    [isLiveActive, stopLiveSession, startLiveSessionWithOptions]
  );

  useEffect(() => {
    return () => {
      shouldStayLiveRef.current = false;
      stopLiveSession(false, false);
    };
  }, [stopLiveSession]);

  // ---------------------------------------------------------------------------
  // UI Handlers
  // ---------------------------------------------------------------------------
  const handleLocationInputChange = useCallback((val: string) => {
    setLocationInput(val);
    locationRef.current = val;
    setGpsError(null);
    setIsGpsLocationActive(
      Boolean(
        val.trim() &&
          gpsLocationLabelRef.current &&
          val.trim() === gpsLocationLabelRef.current
      )
    );
  }, []);

  const handleAddManualAlarm = useCallback((time: string, label: string) => {
    if (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      void Notification.requestPermission();
    }
    setAlarms((prev) => [
      ...prev,
      {
        id: `alarm_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        time: time || '07:00',
        label: label || 'Budzik',
        active: true,
      },
    ]);
  }, []);

  const handleAddManualReminder = useCallback((minutes: number, text: string) => {
    if (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      void Notification.requestPermission();
    }
    const triggerMs = Date.now() + Math.max(1, minutes) * 60000;
    const d = new Date(triggerMs);
    const displayTime = `${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`;
    setReminders((prev) => [
      ...prev,
      {
        id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        text: text || 'Przypomnienie',
        triggerAt: triggerMs,
        displayTime,
      },
    ]);
  }, []);

  const handleSelectTab = (tab: TabId) => {
    switchTab(tab);
    setDetachedWindow(null);
    const hasCustomText = Boolean(locationInput.trim());
    const useCoords = !hasCustomText || isGpsLocationActive ? coordinates : null;
    const effectiveLoc = locationInput.trim() || (coordinates ? '' : '10115 Berlin');

    if (tab === 'food' && !foodData && !isFoodLoading) {
      void performFoodSearch(effectiveLoc, foodCategory, useCoords);
    } else if (tab === 'stays' && !staysData && !isStaysLoading) {
      void performStaysSearch(effectiveLoc, stayType, useCoords);
    } else if (tab === 'transit' && !transitData && !isTransitLoading) {
      void performTransitSearch(
        transitMode,
        transitFrom.trim() || effectiveLoc,
        transitTo
      );
    }
  };

  const handleSelectFoodCategory = (cat: FoodCategory) => {
    setFoodCategory(cat);
    const hasCustomText = Boolean(locationInput.trim());
    const useCoords = !hasCustomText || isGpsLocationActive ? coordinates : null;
    const effectiveLoc = locationInput.trim() || (coordinates ? '' : '10115 Berlin');
    void performFoodSearch(effectiveLoc, cat, useCoords);
  };

  const handleSelectStayType = (st: StayType) => {
    setStayType(st);
    const hasCustomText = Boolean(locationInput.trim());
    const useCoords = !hasCustomText || isGpsLocationActive ? coordinates : null;
    const effectiveLoc = locationInput.trim() || (coordinates ? '' : '10115 Berlin');
    void performStaysSearch(effectiveLoc, st, useCoords);
  };

  const handleSearchStaysByPrice = (
    minPriceEur: number | null,
    maxPriceEur: number | null
  ) => {
    const hasCustomText = Boolean(locationInput.trim());
    const useCoords = !hasCustomText || isGpsLocationActive ? coordinates : null;
    const effectiveLoc = locationInput.trim() || (coordinates ? '' : '10115 Berlin');
    void performStaysSearch(
      effectiveLoc,
      stayType,
      useCoords,
      checkIn,
      checkOut,
      undefined,
      minPriceEur,
      maxPriceEur
    );
  };

  const handleChangeCheckIn = (rawVal: string) => {
    const safeIn = clampStayDate(rawVal, checkIn);
    setCheckIn(safeIn);
    if (checkOut <= safeIn) {
      setCheckOut(addDaysToIso(safeIn, 2));
    }
  };

  const handleChangeCheckOut = (rawVal: string) => {
    const minOut = addDaysToIso(checkIn, 1);
    const safeOut = clampStayDate(rawVal, minOut);
    setCheckOut(safeOut <= checkIn ? minOut : safeOut);
  };

  const handleApplyDatePreset = (newIn: string, newOut: string) => {
    const safeIn = clampStayDate(newIn);
    const safeOut = clampStayDate(newOut, addDaysToIso(safeIn, 2));
    const finalOut = safeOut <= safeIn ? addDaysToIso(safeIn, 2) : safeOut;
    setCheckIn(safeIn);
    setCheckOut(finalOut);
    const hasCustomText = Boolean(locationInput.trim());
    const useCoords = !hasCustomText || isGpsLocationActive ? coordinates : null;
    const effectiveLoc = locationInput.trim() || (coordinates ? '' : '10115 Berlin');
    void performStaysSearch(effectiveLoc, stayType, useCoords, safeIn, finalOut);
  };

  const handleSelectTransitMode = (m: TransitMode) => {
    setTransitMode(m);
    const effectiveFrom =
      transitFrom.trim() || locationInput.trim() || (coordinates ? '' : '10115 Berlin');
    void performTransitSearch(m, effectiveFrom, transitTo);
  };

  const handleQuickFuelNearby = () => {
    setTransitMode('fuel');
    if (coordinatesRef.current) {
      void performTransitSearch('fuel', transitFrom || locationRef.current, '');
    } else if (locationRef.current.trim()) {
      void performTransitSearch('fuel', locationRef.current, '');
      detectFastLocation(false, false, 'fuel');
    } else {
      detectFastLocation(true, true, 'fuel');
    }
  };

  const handleBackFromDetachedWindow = () => {
    performGoBack(1);
  };

  const handleCloseFoodTab = () => {
    performGoBack(1);
  };

  const appBody = (
    <div className="min-h-dvh overflow-x-hidden bg-[#05070B] bg-[radial-gradient(ellipse_85%_40%_at_50%_-10%,rgba(16,185,129,0.12),transparent_70%)] text-[#F1F5F9] flex flex-col">
      {isGmpQuotaExceeded && (
        <div className="bg-[#261B04] border-b border-[#F59E0B]/40 text-[#FCD34D] px-4 py-2 text-xs md:text-sm text-center shrink-0 z-50">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-[#FDE68A] hover:text-white"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      <Header
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        language={language}
        onSelectLanguage={(lang) => void handleSelectLanguage(lang)}
        isLiveActive={isLiveActive}
        liveStatus={liveStatus}
        onToggleLive={handleToggleLive}
      />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-3 py-4 sm:px-6 sm:py-6">
        {activeTab !== 'assistant' && gpsError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[#5C1D22] bg-[#1F0B0D] px-4 py-2.5 text-xs text-[#FCA5A5]"
          >
            <span>{gpsError}</span>
            <button
              type="button"
              onClick={() => setGpsError(null)}
              className="font-semibold underline cursor-pointer shrink-0 hover:text-white"
            >
              Zamknij
            </button>
          </div>
        )}

        {/* Tab 1: Foreground Voice Controls */}
        {activeTab === 'assistant' && (
          <div className="flex flex-1 flex-col gap-4">
            <VoiceDock
              language={language}
              onSelectLanguage={(lang) => void handleSelectLanguage(lang)}
              voiceGender={voiceGender}
              onSelectVoiceGender={(g) => void handleSelectVoiceGender(g)}
              isLiveActive={isLiveActive}
              liveStatus={liveStatus}
              liveErrorMessage={liveErrorMessage || undefined}
              micLevel={micLevel}
              onToggleLive={handleToggleLive}
              isMuted={isMuted}
              onToggleMute={handleToggleMute}
              videoMode={videoMode}
              cameraFacingMode={cameraFacingMode}
              videoError={videoError}
              videoPreviewRef={videoPreviewRef}
              onStopVideo={stopVideoShare}
              storyStatus={storyStatus}
              storyProgress={storyProgress}
              onPauseStory={() => {
                storyPlayerRef.current?.pause();
              }}
              onResumeStory={() => {
                void storyPlayerRef.current?.resume();
              }}
              onStopStory={() => {
                storyPlayerRef.current?.stop();
              }}
            />

            {lastLaunchedApp && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#22C55E]/30 bg-[#081A10] px-4 py-3 text-xs">
                <div>
                  <span className="font-semibold text-[#4ADE80]">
                    {language === 'de' ? 'Gestartet' : 'Uruchomiono'} ({lastLaunchedApp.appLabel}):
                  </span>{' '}
                  <span className="text-[#E2E8F0]">{lastLaunchedApp.title}</span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={lastLaunchedApp.fallbackUrl || lastLaunchedApp.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[#22C55E] px-3 text-xs font-semibold text-[#041409] hover:bg-[#4ADE80]"
                  >
                    <span>
                      {language === 'de' ? 'Öffnen' : 'Otwórz'} {lastLaunchedApp.appLabel}
                    </span>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                  <button
                    type="button"
                    onClick={() => setLastLaunchedApp(null)}
                    className="min-h-[36px] rounded-xl border border-white/[0.08] bg-[#111723] px-3 text-xs text-[#94A3B8] hover:text-white cursor-pointer"
                  >
                    {language === 'de' ? 'Schließen' : 'Zamknij'}
                  </button>
                </div>
              </div>
            )}

            {(activeYoutubeVideo || youtubeResults.length > 0 || isYoutubeLoading || youtubeError) && (
              <div className="w-full shrink-0">
                <YouTubePlayerPanel
                  language={language}
                  query={youtubeQuery}
                  results={youtubeResults}
                  activeVideo={activeYoutubeVideo}
                  isLoading={isYoutubeLoading}
                  error={youtubeError}
                  onSelectVideo={(vid) => setActiveYoutubeVideo(vid)}
                  onPlayAnother={() =>
                    void executeActions([
                      { type: 'select_youtube_track', randomTrack: true, nextTrack: true },
                    ])
                  }
                  onClose={() => {
                    setActiveYoutubeVideo(null);
                    setYoutubeResults([]);
                    setYoutubeError(null);
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Pure Food Search + Google Maps + Phone Ordering + Inline Found Results */}
        {activeTab === 'food' && (
          <div className="flex-1 space-y-4">
            {(activeYoutubeVideo || youtubeResults.length > 0 || isYoutubeLoading || youtubeError) && (
              <YouTubePlayerPanel
                language={language}
                query={youtubeQuery}
                results={youtubeResults}
                activeVideo={activeYoutubeVideo}
                isLoading={isYoutubeLoading}
                error={youtubeError}
                onSelectVideo={(vid) => setActiveYoutubeVideo(vid)}
                onPlayAnother={() =>
                  void executeActions([
                    { type: 'select_youtube_track', randomTrack: true, nextTrack: true },
                  ])
                }
                onClose={() => {
                  setActiveYoutubeVideo(null);
                  setYoutubeResults([]);
                  setYoutubeError(null);
                }}
              />
            )}
            <FoodTab
              category={foodCategory}
              onSelectCategory={handleSelectFoodCategory}
              locationInput={locationInput}
              onLocationInputChange={handleLocationInputChange}
              onSearchByLocation={(locOverride?: string) => {
                const targetLoc = (locOverride ?? locationInput).trim();
                if (locOverride !== undefined) {
                  handleLocationInputChange(locOverride);
                }
                setIsGpsLocationActive(false);
                void performFoodSearch(
                  targetLoc || (coordinates ? '' : '10115 Berlin'),
                  foodCategory,
                  targetLoc ? null : coordinates
                );
              }}
              onUseMyLocation={() => detectFastLocation(true, true)}
              hasGpsLock={Boolean(coordinates)}
              isLocating={isLocating}
              coordinates={locationInput.trim() && !isGpsLocationActive ? undefined : coordinates}
              hasMapsProvider={Boolean(mapsApiKey)}
              data={foodData}
              isLoading={isFoodLoading}
              error={foodError}
              onOpenDialer={(target) => setDialTarget(target)}
              onRetrySearch={() =>
                void performFoodSearch(
                  locationInput.trim() || (coordinates ? '' : '10115 Berlin'),
                  foodCategory,
                  locationInput.trim() && !isGpsLocationActive ? null : coordinates
                )
              }
              onCloseTab={handleCloseFoodTab}
            />
          </div>
        )}

        {/* Tab 3: Pure Stays Search + Automatic Booking + Inline Found Results */}
        {activeTab === 'stays' && (
          <div className="flex-1 space-y-4">
            {(activeYoutubeVideo || youtubeResults.length > 0 || isYoutubeLoading || youtubeError) && (
              <YouTubePlayerPanel
                language={language}
                query={youtubeQuery}
                results={youtubeResults}
                activeVideo={activeYoutubeVideo}
                isLoading={isYoutubeLoading}
                error={youtubeError}
                onSelectVideo={(vid) => setActiveYoutubeVideo(vid)}
                onPlayAnother={() =>
                  void executeActions([
                    { type: 'select_youtube_track', randomTrack: true, nextTrack: true },
                  ])
                }
                onClose={() => {
                  setActiveYoutubeVideo(null);
                  setYoutubeResults([]);
                  setYoutubeError(null);
                }}
              />
            )}
            <StaysTab
              stayType={stayType}
              onSelectStayType={handleSelectStayType}
              locationInput={locationInput}
              onLocationInputChange={handleLocationInputChange}
              onSearchByLocation={() => {
                setIsGpsLocationActive(false);
                void performStaysSearch(
                  locationInput.trim() || (coordinates ? '' : '10115 Berlin'),
                  stayType,
                  locationInput.trim() ? null : coordinates
                );
              }}
              onUseMyLocation={() => detectFastLocation(true, true)}
              hasGpsLock={Boolean(coordinates)}
              isLocating={isLocating}
              checkIn={checkIn}
              checkOut={checkOut}
              guests={guests}
              onChangeCheckIn={handleChangeCheckIn}
              onChangeCheckOut={handleChangeCheckOut}
              onApplyDatePreset={handleApplyDatePreset}
              onChangeGuests={setGuests}
              data={staysData}
              isLoading={isStaysLoading}
              error={staysError}
              bookings={stayBookings}
              isAutoBooking={isAutoBooking}
              onOpenAutoBookModal={(stay) => setAutoBookingTarget(stay)}
              onAutoBookBest={() => {
                const bestStay = staysDataRef.current?.results?.[0];
                void performAutoBookStay({
                  stay: bestStay,
                  location: locationInput,
                  checkIn,
                  checkOut,
                  guests,
                });
              }}
              onRemoveBooking={(id) =>
                setStayBookings((prev) => prev.filter((b) => b.id !== id))
              }
              onOpenDialer={(target) => setDialTarget(target)}
              onRetrySearch={() =>
                void performStaysSearch(
                  locationInput.trim() || (coordinates ? '' : '10115 Berlin'),
                  stayType,
                  locationInput.trim() && !isGpsLocationActive ? null : coordinates
                )
              }
              onSearchByPrice={handleSearchStaysByPrice}
              onOpenDetached={() => setDetachedWindow('stays')}
            />
          </div>
        )}

        {/* Tab 4: Transit (Trains, S-Bahn, Buses, Car Driving Route & Fuel Prices) + Inline Found Results */}
        {activeTab === 'transit' && (
          <div className="flex-1 space-y-4">
            {(activeYoutubeVideo || youtubeResults.length > 0 || isYoutubeLoading || youtubeError) && (
              <YouTubePlayerPanel
                language={language}
                query={youtubeQuery}
                results={youtubeResults}
                activeVideo={activeYoutubeVideo}
                isLoading={isYoutubeLoading}
                error={youtubeError}
                onSelectVideo={(vid) => setActiveYoutubeVideo(vid)}
                onPlayAnother={() =>
                  void executeActions([
                    { type: 'select_youtube_track', randomTrack: true, nextTrack: true },
                  ])
                }
                onClose={() => {
                  setActiveYoutubeVideo(null);
                  setYoutubeResults([]);
                  setYoutubeError(null);
                }}
              />
            )}
            <TransitTab
              mode={transitMode}
              onSelectMode={handleSelectTransitMode}
              fromInput={transitFrom}
              toInput={transitTo}
              onChangeFrom={setTransitFrom}
              onChangeTo={setTransitTo}
              onSearch={() =>
                void performTransitSearch(
                  transitMode,
                  transitFrom || locationInput,
                  transitTo
                )
              }
              data={transitData}
              isLoading={isTransitLoading}
              error={transitError}
              coordinates={coordinates}
              globalLocationInput={locationInput}
              hasMapsProvider={Boolean(mapsApiKey)}
              onUseMyLocation={() => detectFastLocation(true, true)}
              onQuickFuelNearby={handleQuickFuelNearby}
              isLocating={isLocating}
              onOpenDetached={() => setDetachedWindow('transit')}
            />
          </div>
        )}
        {/* Tab 5: Tools, Camera, YouTube, WhatsApp, Calculator, Notepad, Alarms & Reminders */}
        {activeTab === 'tools' && (
          <div className="flex-1 space-y-4">
            {(activeYoutubeVideo || youtubeResults.length > 0 || isYoutubeLoading || youtubeError) && (
              <YouTubePlayerPanel
                language={language}
                query={youtubeQuery}
                results={youtubeResults}
                activeVideo={activeYoutubeVideo}
                isLoading={isYoutubeLoading}
                error={youtubeError}
                onSelectVideo={(vid) => setActiveYoutubeVideo(vid)}
                onPlayAnother={() =>
                  void executeActions([
                    { type: 'select_youtube_track', randomTrack: true, nextTrack: true },
                  ])
                }
                onClose={() => {
                  setActiveYoutubeVideo(null);
                  setYoutubeResults([]);
                  setYoutubeError(null);
                }}
              />
            )}
            <ToolsTab
              language={language}
              videoMode={videoMode}
              cameraFacingMode={cameraFacingMode}
              videoError={videoError}
              videoPreviewRef={videoPreviewRef}
              onToggleCamera={() => void handleToggleCamera()}
              onSwitchCameraFacing={() => void handleSwitchCameraFacing()}
              onToggleScreenShare={() => void handleToggleScreenShare()}
              onStopVideo={stopVideoShare}
              alarms={alarms}
              reminders={reminders}
              onAddAlarm={handleAddManualAlarm}
              onRemoveAlarm={(id) =>
                setAlarms((prev) => prev.filter((a) => a.id !== id))
              }
              onAddReminder={handleAddManualReminder}
              onRemoveReminder={(id) =>
                setReminders((prev) => prev.filter((r) => r.id !== id))
              }
              lastLaunchedApp={lastLaunchedApp}
              onDismissLaunchedApp={() => setLastLaunchedApp(null)}
              onOpenCalculator={() => setIsCalculatorOpen(true)}
              onOpenNotepad={() => setIsNotepadOpen(true)}
              onOpenYoutube={() =>
                void executeActions([
                  {
                    type: 'open_youtube',
                    service: 'youtube_music',
                    query: language === 'de' ? 'Musik Hits' : 'Polskie hity',
                  },
                ])
              }
              onOpenWhatsapp={() => setIsWhatsappModalOpen(true)}
              onOpenBrowser={() => {
                setIsBrowserOpen(true);
                isBrowserOpenRef.current = true;
              }}
              notesCount={notepadNotes.length}
            />
          </div>
        )}
      </main>

      <footer className="shrink-0 border-t border-white/[0.06] bg-[#06090F] py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-[11px] text-[#64748B] sm:px-6">
          <span>Miękiszon</span>
          <span>PL / DE</span>
        </div>
      </footer>

      <DetachedWindowModal
        windowTab={detachedWindow}
        previousTab={previousTab}
        onClose={() => setDetachedWindow(null)}
        onBackToPrevious={handleBackFromDetachedWindow}
      >
        {(activeYoutubeVideo || youtubeResults.length > 0 || isYoutubeLoading || youtubeError) && (
          <div className="mb-4">
            <YouTubePlayerPanel
              language={language}
              query={youtubeQuery}
              results={youtubeResults}
              activeVideo={activeYoutubeVideo}
              isLoading={isYoutubeLoading}
              error={youtubeError}
              onSelectVideo={(vid) => setActiveYoutubeVideo(vid)}
              onPlayAnother={() =>
                void executeActions([
                  { type: 'select_youtube_track', randomTrack: true, nextTrack: true },
                ])
              }
              onClose={() => {
                setActiveYoutubeVideo(null);
                setYoutubeResults([]);
                setYoutubeError(null);
              }}
            />
          </div>
        )}
        {detachedWindow === 'stays' && (
          <StaysTab
            stayType={stayType}
            onSelectStayType={handleSelectStayType}
            locationInput={locationInput}
            onLocationInputChange={handleLocationInputChange}
            onSearchByLocation={() => {
              setIsGpsLocationActive(false);
              void performStaysSearch(
                locationInput.trim() || (coordinates ? '' : '10115 Berlin'),
                stayType,
                locationInput.trim() ? null : coordinates
              );
            }}
            onUseMyLocation={() => detectFastLocation(true, true)}
            hasGpsLock={Boolean(coordinates)}
            isLocating={isLocating}
            checkIn={checkIn}
            checkOut={checkOut}
            guests={guests}
            onChangeCheckIn={handleChangeCheckIn}
            onChangeCheckOut={handleChangeCheckOut}
            onApplyDatePreset={handleApplyDatePreset}
            onChangeGuests={setGuests}
            data={staysData}
            isLoading={isStaysLoading}
            error={staysError}
            bookings={stayBookings}
            isAutoBooking={isAutoBooking}
            onOpenAutoBookModal={(stay) => setAutoBookingTarget(stay)}
            onAutoBookBest={() => {
              const bestStay = staysDataRef.current?.results?.[0];
              void performAutoBookStay({
                stay: bestStay,
                location: locationInput,
                checkIn,
                checkOut,
                guests,
              });
            }}
            onRemoveBooking={(id) =>
              setStayBookings((prev) => prev.filter((b) => b.id !== id))
            }
            onOpenDialer={(target) => setDialTarget(target)}
            onRetrySearch={() =>
              void performStaysSearch(
                locationInput.trim() || (coordinates ? '' : '10115 Berlin'),
                stayType,
                locationInput.trim() && !isGpsLocationActive ? null : coordinates
              )
            }
            onSearchByPrice={handleSearchStaysByPrice}
          />
        )}
        {detachedWindow === 'transit' && (
          <TransitTab
            mode={transitMode}
            onSelectMode={handleSelectTransitMode}
            fromInput={transitFrom}
            toInput={transitTo}
            onChangeFrom={setTransitFrom}
            onChangeTo={setTransitTo}
            onSearch={() =>
              void performTransitSearch(
                transitMode,
                transitFrom || locationInput,
                transitTo
              )
            }
            data={transitData}
            isLoading={isTransitLoading}
            error={transitError}
            coordinates={coordinates}
            globalLocationInput={locationInput}
            hasMapsProvider={Boolean(mapsApiKey)}
            onUseMyLocation={() => detectFastLocation(true, true)}
            onQuickFuelNearby={handleQuickFuelNearby}
            isLocating={isLocating}
          />
        )}
      </DetachedWindowModal>

      <AutoBookingModal
        stay={autoBookingTarget}
        checkIn={checkIn}
        checkOut={checkOut}
        guests={guests}
        isSubmitting={isAutoBooking}
        onClose={() => setAutoBookingTarget(null)}
        onConfirm={(payload) => void performAutoBookStay(payload)}
      />

      <WhatsappModal
        isOpen={isWhatsappModalOpen}
        onClose={() => setIsWhatsappModalOpen(false)}
        contacts={whatsappContacts}
        onUpdateContacts={setWhatsappContacts}
        message={whatsappMessage}
        onChangeMessage={setWhatsappMessage}
      />

      <DialerModal target={dialTarget} onClose={() => setDialTarget(null)} />

      <CalculatorModal
        isOpen={isCalculatorOpen}
        language={language}
        initialExpression={calculatorExpr}
        onClose={() => setIsCalculatorOpen(false)}
      />

      <NotepadModal
        isOpen={isNotepadOpen}
        language={language}
        notes={notepadNotes}
        onAddNote={(text) => {
          setNotepadNotes((prev) => [
            {
              id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
              text,
              createdAt: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              }),
            },
            ...prev,
          ]);
        }}
        onDeleteNote={(id) =>
          setNotepadNotes((prev) => prev.filter((n) => n.id !== id))
        }
        onClearAll={() => setNotepadNotes([])}
        onClose={() => setIsNotepadOpen(false)}
      />

      <BrowserModal
        isOpen={isBrowserOpen}
        language={language}
        query={browserQuery}
        data={browserData}
        isLoading={isBrowserLoading}
        error={browserError}
        article={browserArticle}
        isArticleLoading={isBrowserArticleLoading}
        canGoBack={Boolean(browserArticle) || browserHistoryRef.current.length > 0}
        onSearch={(q) => void performBrowserSearch(q, false, true)}
        onSelectArticle={(item) => void performOpenBrowserArticle(item, false)}
        onReadArticleAloud={(txt) => void speakWithMiekiszon(txt.slice(0, 750))}
        onGoBack={() => performGoBack(1)}
        onClose={() => {
          setIsBrowserOpen(false);
          isBrowserOpenRef.current = false;
          setBrowserArticle(null);
          browserArticleRef.current = null;
        }}
      />

      <OfflineIndicator />
    </div>
  );

  if (mapsApiKey) {
    return (
      <APIProvider
        apiKey={mapsApiKey}
        libraries={['maps', 'places', 'marker', 'core', 'routes']}
        language={language === 'de' ? 'de' : 'pl'}
      >
        <GooglePlacesFoodBridge onRegisterSearch={handleRegisterGoogleFoodSearch} />
        {appBody}
      </APIProvider>
    );
  }

  return appBody;
}
