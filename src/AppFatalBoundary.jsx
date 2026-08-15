import React from "react";
import {
  fatalHostRecoveryView,
  stopExistingAudioForFatalHostError
} from "./audio/fatalHostAudioSafety";
import {
  captureFatalHostEvent,
  fatalHostEventSnapshot,
  retryFatalHostEventStop,
  subscribeFatalHostEvents
} from "./audio/fatalHostEventBoundary";

export default class AppFatalBoundary extends React.Component {
  state = fatalHostEventSnapshot();
  alertRef = React.createRef();
  unsubscribeFatalHostEvents = null;

  static getDerivedStateFromError(error) {
    return captureFatalHostEvent(error);
  }

  componentDidCatch() {
    window.requestAnimationFrame(() => this.alertRef.current?.focus?.());
  }

  componentDidMount() {
    this.unsubscribeFatalHostEvents = subscribeFatalHostEvents((next) => {
      this.setState(next, () => window.requestAnimationFrame(() => this.alertRef.current?.focus?.()));
    });
    window.addEventListener("pagehide", this.onPageHide);
    if (this.state.failed) window.requestAnimationFrame(() => this.alertRef.current?.focus?.());
  }

  componentWillUnmount() {
    window.removeEventListener("pagehide", this.onPageHide);
    this.unsubscribeFatalHostEvents?.();
    this.unsubscribeFatalHostEvents = null;
  }

  onPageHide = () => {
    if (this.state.failed) stopExistingAudioForFatalHostError();
  };

  retryStop = () => {
    retryFatalHostEventStop();
  };

  reload = () => window.location.reload();

  render() {
    if (!this.state.failed) return this.props.children;
    const view = fatalHostRecoveryView(this.state.outcome);
    return (
      <main className="fatal-host-recovery">
        <section
          ref={this.alertRef}
          className={`fatal-host-recovery-card ${view.status}`}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          tabIndex={-1}
        >
          <p className="fatal-host-recovery-kicker">LOCAL RECOVERY</p>
          <h1>{view.title}</h1>
          <p>{view.message}</p>
          <div className="fatal-host-recovery-actions">
            <button type="button" onClick={this.retryStop}>{view.stopAction}</button>
            <button type="button" onClick={this.reload}>{view.reloadAction}</button>
          </div>
          <small>Reloading does not delete your saved local music.</small>
        </section>
      </main>
    );
  }
}
