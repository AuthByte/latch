import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <section className="card narrow center">
      <p className="eyebrow">404</p>
      <h1 className="h-page">Nothing latched here.</h1>
      <p className="muted">That page doesn&rsquo;t exist.</p>
      <Link className="btn btn-primary" to="/">
        Back to home
      </Link>
    </section>
  );
}
