const MAX_VISIBLE = 8;
const stripControls = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
const rateFormatter = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });

function price(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unavailable';
  return value === 0 ? '$0.00' : `$${rateFormatter.format(value)}`;
}

export function createModelPicker(models, currentIndex, signal, { Input, SelectList, Text, truncateToWidth }) {
  return (tui, theme, _keybindings, done) => {
    const search = new Input({ prompt: 'Filter: ', placeholder: 'provider, id, or name' });
    const title = new Text('Choose an authenticated Sidekick model', 0, 0);
    const hint = new Text('Type to filter · ↑↓ navigate · Enter select · Esc cancel', 0, 0);
    const candidates = models.map((model, index) => ({
      model,
      index,
      searchText: `${model.provider} ${model.id} ${model.name ?? ''}`.toLowerCase(),
    }));
    let list;
    let footer = new Text('', 0, 0);
    let finished = false;
    let focused = true;
    search.focused = focused;

    function finish(result) {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      done(result);
    }

    function onAbort() {
      finish(null);
    }

    function updateFooter() {
      const index = Number(list.getSelectedItem()?.value);
      const model = Number.isSafeInteger(index) ? models[index] : undefined;
      footer.setText(model
        ? `Selected ${stripControls(`${model.provider}/${model.id}`)} · API rates (USD/1M tokens): input ${price(model.cost?.input)} · cache-read ${price(model.cost?.cacheRead)} · output ${price(model.cost?.output)}`
        : 'No model selected · API USD/1M token prices unavailable');
    }

    function updateList(query = '') {
      const normalizedQuery = query.trim().toLowerCase();
      const matches = candidates.filter(candidate => candidate.searchText.includes(normalizedQuery));
      list = new SelectList(matches.map(({ model, index }) => {
        const name = typeof model.name === 'string' ? stripControls(model.name).trim() : '';
        const identity = stripControls(`${model.provider}/${model.id}`);
        return {
          value: String(index),
          label: `${identity}${name && name !== model.id ? ` · ${name}` : ''}${index === currentIndex ? ' (Current)' : ''}`,
        };
      }), MAX_VISIBLE, {
        selectedPrefix: text => theme.fg('accent', text),
        selectedText: text => theme.fg('accent', text),
        description: text => theme.fg('muted', text),
        scrollInfo: text => theme.fg('dim', text),
        noMatch: () => theme.fg('warning', '  No matching models'),
      });
      list.onSelect = item => {
        const index = Number(item.value);
        if (Number.isSafeInteger(index) && models[index]) finish(index);
      };
      list.onCancel = () => finish(null);
      list.onSelectionChange = updateFooter;
      if (!normalizedQuery && currentIndex >= 0) {
        const current = matches.findIndex(({ index }) => index === currentIndex);
        if (current >= 0) list.setSelectedIndex(current);
      }
      updateFooter();
    }

    updateList();
    if (signal?.aborted) queueMicrotask(onAbort);
    else signal?.addEventListener('abort', onAbort, { once: true });

    return {
      get focused() { return focused; },
      set focused(value) {
        focused = value;
        search.focused = value;
      },
      render(width) {
        return [
          ...title.render(width),
          ...search.render(width),
          ...list.render(width).map(line => truncateToWidth(line, width, '')),
          ...footer.render(width),
          ...hint.render(width),
        ];
      },
      invalidate() {
        title.invalidate();
        search.invalidate();
        list.invalidate();
        footer.invalidate();
        hint.invalidate();
      },
      handleInput(data) {
        if (finished) return;
        const previous = search.getValue();
        search.handleInput(data);
        if (search.getValue() !== previous) updateList(search.getValue());
        else list.handleInput(data);
        if (!finished) tui.requestRender();
      },
      dispose() {
        finish(null);
      },
    };
  };
}
