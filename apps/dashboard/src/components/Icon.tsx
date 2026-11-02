import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  CornerDownLeft,
  GitBranch,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Timer,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** Icons come from lucide (MIT licence). Decorative: hidden from assistive technology. */
const ICONS = {
  logo: Zap,
  overview: LayoutDashboard,
  jobs: ListChecks,
  workflows: GitBranch,
  schedules: Clock,
  workers: Server,
  keys: KeyRound,
  team: Users,
  audit: ShieldCheck,
  settings: Settings,
  plus: Plus,
  send: Send,
  sun: Sun,
  moon: Moon,
  menu: Menu,
  close: X,
  copy: Copy,
  check: Check,
  logout: LogOut,
  shield: ShieldCheck,
  bolt: Zap,
  refresh: RefreshCw,
  layers: Layers,
  chart: BarChart3,
  search: Search,
  arrow: ArrowRight,
  chevron: ChevronRight,
  enter: CornerDownLeft,
  activity: Activity,
  timer: Timer,
  success: CheckCircle2,
  alert: CircleAlert,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className="icon"
      strokeWidth={1.75}
      aria-hidden="true"
      focusable="false"
      {...(size ? { size } : {})}
    />
  );
}
