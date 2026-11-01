import { Link } from "react-router-dom";
import { Icon, type IconName } from "../components/Icon";
import { useTheme } from "../lib/theme";

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "shield",
    title: "Nothing is lost",
    text: "A job is saved before it is acknowledged. If a server restarts, the work is still there.",
  },
  {
    icon: "refresh",
    title: "Retries and recovery",
    text: "Failures retry with exponential backoff. If a worker crashes, its jobs are picked up again by another.",
  },
  {
    icon: "schedules",
    title: "Schedules",
    text: "Run work on a cron schedule in any time zone, without a separate scheduler to look after.",
  },
  {
    icon: "workflows",
    title: "Workflows",
    text: "Chain jobs into a graph where each step starts only after the steps it depends on have succeeded.",
  },
  {
    icon: "chart",
    title: "See what is happening",
    text: "Live queue depth, throughput, failures and timings, with a full history of every attempt.",
  },
  {
    icon: "team",
    title: "Built for teams",
    text: "Admins manage keys and members; viewers get read-only access. Each organisation sees only its own data.",
  },
];

const STEPS = [
  {
    title: "Create an API key",
    text: "In the dashboard, make a client key for your app and a worker key for your workers. Keys are shown once and can be revoked at any time.",
  },
  {
    title: "Run a worker",
    text: "Register handlers for your job types with the Node SDK. Workers pull jobs, renew their lease while working, and report the result.",
  },
  {
    title: "Submit jobs",
    text: "Queue jobs from your application with the SDK (or plain HTTP), or schedule them. Watch them run in the dashboard.",
  },
];

const SNIPPET = `import { WorkMesh, Worker } from "@workmesh/worker-sdk";

// In your application: queue a job (a client key)
const workmesh = new WorkMesh({ apiUrl, apiKey: process.env.WORKMESH_CLIENT_KEY });
await workmesh.jobs.submit({
  type: "email.send",
  payload: { to: "ada@example.com" },
  idempotencyKey: "welcome-ada", // safe to retry
});

// In your worker: run it (a worker key)

const worker = new Worker({
  apiUrl: "https://your-workmesh.example",
  apiKey: process.env.WORKMESH_API_KEY, // a worker key
  concurrency: 4,
});

worker.register("email.send", async (job) => {
  await sendEmail(job.payload.to); // retried if it throws
});

await worker.start();`;

export function LandingPage() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="public">
      <header className="public-nav">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <Icon name="logo" />
          </span>
          WorkMesh
        </Link>
        <nav className="links" aria-label="Account">
          <button
            type="button"
            className="icon-button"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <Link to="/login" className="btn ghost">
            Sign in
          </Link>
          <Link to="/signup" className="btn primary">
            Create account
          </Link>
        </nav>
      </header>

      <main id="main">
        <section className="hero">
          <h1>
            Background jobs that <em>always get done</em>
          </h1>
          <p className="lead">
            WorkMesh runs your background work reliably: queued jobs, retries, schedules and
            workflows, with a dashboard your whole team can use.
          </p>
          <div className="cta">
            <Link to="/signup" className="btn primary lg">
              Get started
            </Link>
            <Link to="/login" className="btn lg">
              Sign in
            </Link>
          </div>
        </section>

        <section className="section" aria-labelledby="features-h">
          <h2 id="features-h">Everything you need to run work in the background</h2>
          <p className="sub">
            A job engine you can reason about: every job has a state, every attempt is recorded, and
            every failure has an explanation.
          </p>
          <div className="features">
            {FEATURES.map((f) => (
              <article key={f.title} className="card feature">
                <div className="icon-wrap">
                  <Icon name={f.icon} />
                </div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section" aria-labelledby="how-h">
          <h2 id="how-h">Up and running in three steps</h2>
          <p className="sub">
            Your code runs on your own servers. WorkMesh stores and schedules the work.
          </p>
          <div className="split">
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <pre aria-label="Example worker code">
              <code>{SNIPPET}</code>
            </pre>
          </div>
        </section>

        <section className="section">
          <div className="cta-band">
            <h2>Ready to stop worrying about your background work?</h2>
            <Link to="/signup" className="btn primary lg">
              Create your account
            </Link>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>WorkMesh: a durable job and workflow engine.</span>
        <span>
          <Link to="/login">Sign in</Link> · <Link to="/signup">Create account</Link>
        </span>
      </footer>
    </div>
  );
}
