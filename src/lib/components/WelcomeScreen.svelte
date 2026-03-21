<script lang="ts">
  interface Props {
    onNewTab: () => void;
  }

  let { onNewTab }: Props = $props();
</script>

<div class="welcome">
  <div class="welcome-content">
    <h1>CLCOMX</h1>
    <p>Multi-agent CLI workspace</p>
    <button class="new-session-btn" onclick={onNewTab}>
      + New Session
    </button>
    <p class="shortcut">or press <kbd>Ctrl</kbd>+<kbd>T</kbd></p>
  </div>
</div>

<style>
  .welcome {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
  }

  .welcome-content {
    text-align: center;
  }

  h1 {
    font-size: 36px;
    font-weight: 300;
    margin-bottom: 8px;
    color: var(--tab-text);
  }

  p {
    color: var(--tab-text);
    opacity: 0.6;
    margin-bottom: 24px;
  }

  .new-session-btn {
    padding: 10px 24px;
    font-size: 15px;
    background: var(--tab-active-bg);
    color: var(--tab-text);
    border: 1px solid var(--tab-border);
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .new-session-btn:hover {
    background: var(--tab-border);
  }

  .shortcut {
    font-size: 12px;
    margin-top: 12px;
  }

  kbd {
    padding: 2px 6px;
    border: 1px solid var(--tab-border);
    border-radius: 3px;
    font-family: inherit;
    font-size: 11px;
    background: var(--tab-active-bg);
  }
</style>
