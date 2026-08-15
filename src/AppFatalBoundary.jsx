import React from "react";
import {
  captureFatalHostFailure,
  fatalHostRecoveryView,
  stopExistingAudioForFatalHostError
} from "./audio/fatalHostAudioSafety";

export default class AppFatalBoundary extends React.Component {
  state = { failed: false, outcome: null };
  alertRef = React.createRef();

  static getDerivedStateFromError(error) {
    return captureFatalHostFailure(error);
  }

  componentDidCatch() {
    window.requestAnimationFrame(() => this.alertRef.current?.focus?.());
  }

  componentDidMount() {
    window.addEventListener("pagehide", this.onPageHide);
  }

  componentWillUnmount() {
    window.removeEventListener("pagehide", this.onPageHide);
  }

  onPageHide = () => {
    if (this.state.failed) stopExistingAudioForFatalHostError();
  };

  retryStop = () => {
    const result = stopExistingAudioForFatalHostError();
    this.setState({ outcome: result.outcome });
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
