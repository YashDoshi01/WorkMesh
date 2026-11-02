import { Fragment, useState, type ReactNode } from "react";
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

const PRINCIPLES = [
  { title: "At-least-once delivery", text: "A job runs again if its worker disappears." },
  { title: "Safe to retry", text: "Idempotency keys stop duplicate jobs." },
  { title: "Isolated by organisation", text: "Keys and data never cross customers." },
  { title: "Least-privilege keys", text: "Separate client and worker keys." },
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

const SUBMIT_CODE = `import { WorkMesh } from "workmesh-sdk-service";

const workmesh = new WorkMesh({
  apiUrl: "https://your-workmesh.example",
  apiKey: process.env.WORKMESH_CLIENT_KEY, // a client key
});

// Safe to retry: the same key returns the same job.
const job = await workmesh.jobs.submit({
  type: "email.send",
  payload: { to: "ada@example.com" },
  idempotencyKey: "welcome-ada",
});

console.log(job.id, job.status); // queued`;

const WORKER_CODE = `import { Worker } from "workmesh-sdk-service";

const worker = new Worker({
  apiUrl: "https://your-workmesh.example",
  apiKey: process.env.WORKMESH_API_KEY, // a worker key
  concurrency: 4,
});

worker.register("email.send", async (job) => {
  await sendEmail(job.payload.to); // retried if it throws
});

await worker.start();`;

const FAQ = [
  {
    q: "Do I have to host anything?",
    a: "Your application and your workers run on your own servers. WorkMesh stores the jobs, schedules them, tracks every attempt and shows it all in the dashboard.",
  },
  {
    q: "Can a job run twice?",
    a: "Delivery is at-least-once: if a worker dies mid-job, another one runs it again, so handlers should be safe to repeat. Idempotency keys make sure that submitting the same job twice creates it only once.",
  },
  {
    q: "What happens when a worker crashes?",
    a: "Each running job holds a short lease that the worker keeps renewing. When it stops, the lease expires and the job goes back to the queue with a retry delay.",
  },
  {
    q: "Who can see my jobs?",
    a: "Only people in your organisation. Admins can change things; viewers are read-only. API keys belong to one organisation and cannot see another.",
  },
  {
    q: "Which languages are supported?",
    a: "There is a Node.js SDK (npm install workmesh-sdk-service). Anything else can use the HTTP API directly.",
  },
];

/** Colours the sample code. Small on purpose: it only has to cope with the two samples above. */
function highlight(code: string): ReactNode[] {
  const token =
    /(\/\/.*$)|("(?:[^"\\]|\\.)*")|\b(import|from|const|await|async|new)\b|\b([A-Za-z_]\w*)(?=\()/gm;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(token)) {
    const at = m.index ?? 0;
    if (at > last) out.push(code.slice(last, at));
    const kind = m[1] ? "c" : m[2] ? "s" : m[3] ? "k" : "f";
    out.push(
      <span key={at} className={`tok-${kind}`}>
        {m[0]}
      </span>,
    );
    last = at + m[0].length;
  }
  out.push(code.slice(last));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

function ProductPreview() {
  const bars = [30, 44, 38, 56, 48, 70, 52, 64, 80, 58, 72, 90, 66, 84];
  return (
    <div className="preview-wrap">
      <div className="preview" role="img" aria-label="An illustration of the WorkMesh dashboard">
        <div className="preview-side" aria-hidden="true">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="logo" />
            </span>
            WorkMesh
          </div>
          <p className="on">
            <Icon name="overview" /> Overview
          </p>
          <p>
            <Icon name="jobs" /> Jobs
          </p>
          <p>
            <Icon name="workflows" /> Workflows
          </p>
          <p>
            <Icon name="schedules" /> Schedules
          </p>
          <p>
            <Icon name="workers" /> Workers
          </p>
          <p>
            <Icon name="keys" /> API keys
          </p>
        </div>
        <div className="preview-main" aria-hidden="true">
          <h3>Overview</h3>
          <div className="preview-kpis">
            <div>
              <small>Succeeded</small>
              <b>1,284</b>
            </div>
            <div>
              <small>Failed</small>
              <b>3</b>
            </div>
            <div>
              <small>Throughput</small>
              <b>21.4 /min</b>
            </div>
          </div>
          <div className="preview-chart">
            {bars.map((h, i) => (
              <i key={i} className={i % 5 === 3 ? "f" : ""} style={{ height: `${h}%` }} />
            ))}
          </div>
          <div className="preview-rows">
            <div>
              <span className="mono">3f9a21c4</span>
              <span>invoice.generate</span>
              <span className="badge badge-good">
                <span aria-hidden="true" />
                succeeded
              </span>
            </div>
            <div>
              <span className="mono">b71e0d58</span>
              <span>email.send</span>
              <span className="badge badge-info">
                <span aria-hidden="true" />
                running
              </span>
            </div>
            <div>
              <span className="mono">0c8d4e92</span>
              <span>report.build</span>
              <span className="badge badge-neutral">
                <span aria-hidden="true" />
                queued
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  const [theme, setTheme] = useTheme();
  const [tab, setTab] = useState<"submit" | "worker">("submit");
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
          <span className="pill">
            <b>New</b> Idempotent job submission in the Node SDK
          </span>
          <h1>
            Background jobs that <em>always get done</em>
          </h1>
          <p className="lead">
            WorkMesh runs your background work reliably: queued jobs, retries, schedules and
            workflows, with a dashboard your whole team can use.
          </p>
          <div className="cta">
            <Link to="/signup" className="btn primary lg">
              Get started <Icon name="arrow" />
            </Link>
            <Link to="/login" className="btn lg">
              Sign in
            </Link>
          </div>
          <p className="hero-note">
            Create an organisation, make a key and send your first job in a few minutes.
          </p>
          <ProductPreview />
        </section>

        <section className="section" aria-label="Design principles">
          <div className="principles">
            {PRINCIPLES.map((p) => (
              <div key={p.title}>
                <strong>{p.title}</strong>
                <span>{p.text}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="section" aria-labelledby="features-h">
          <span className="eyebrow">Features</span>
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
          <span className="eyebrow">How it works</span>
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
            <div className="codebox">
              <div className="codebox-bar">
                <i />
                <i />
                <i />
                <div className="codebox-tabs" role="tablist" aria-label="Code examples">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "submit"}
                    onClick={() => setTab("submit")}
                  >
                    Queue a job
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "worker"}
                    onClick={() => setTab("worker")}
                  >
                    Run a worker
                  </button>
                </div>
              </div>
              <pre role="tabpanel" aria-label={tab === "submit" ? "Queue a job" : "Run a worker"}>
                <code>{highlight(tab === "submit" ? SUBMIT_CODE : WORKER_CODE)}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="faq-h">
          <span className="eyebrow">FAQ</span>
          <h2 id="faq-h">Questions, answered plainly</h2>
          <p className="sub">The honest version, including the trade-offs.</p>
          <div className="faq">
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="cta-band">
            <h2>Ready to stop worrying about your background work?</h2>
            <p>Set up your organisation and send your first job today.</p>
            <Link to="/signup" className="btn primary lg">
              Create your account
            </Link>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div>
          <Link to="/" className="brand">
            <span className="brand-mark">
              <Icon name="logo" />
            </span>
            WorkMesh
          </Link>
          <p style={{ marginTop: 12, maxWidth: 320 }}>
            A durable job and workflow engine: queues, retries, schedules and workflows.
          </p>
        </div>
        <div>
          <h4>Product</h4>
          <Link to="/signup">Create account</Link>
          <Link to="/login">Sign in</Link>
        </div>
        <div>
          <h4>Developers</h4>
          <a href="https://www.npmjs.com/package/workmesh-sdk-service" rel="noreferrer">
            Node SDK on npm
          </a>
        </div>
        <div className="footer-fine">WorkMesh. Built for reliable background work.</div>
      </footer>
    </div>
  );
}
