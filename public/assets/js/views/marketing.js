import { api } from '../api.js';
import { h, icon, table, toast } from '../dom.js';
import { date, number } from '../format.js';
import { t } from '../i18n.js';

const CHANNELS = ['STORE', 'MOBILE_APP', 'ECOMMERCE', 'MULTI', 'NONE'];

function localDateTimeInput() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function reviewCard(review) {
  const author = review.author
    ? review.authorUri
      ? h(
          'a',
          {
            href: review.authorUri,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          review.author,
        )
      : h('strong', {}, review.author)
    : h('span', { class: 'muted' }, 'Google Maps user');
  return h(
    'article',
    { class: 'review-card' },
    h(
      'div',
      { class: 'review-card__header' },
      h(
        'div',
        {},
        author,
        h('span', { class: 'muted' }, review.publishedAt ? date(review.publishedAt) : ''),
      ),
      h('span', { class: 'review-card__rating' }, `${review.rating ?? '—'} / 5`),
    ),
    h('p', {}, review.text || 'No written review'),
    review.googleMapsUri &&
      h(
        'a',
        {
          href: review.googleMapsUri,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'View on Google Maps',
      ),
  );
}

export async function renderMarketing(view, { branches, can }) {
  const sections = [];
  const outletReviews = h('div', { class: 'review-results' });
  if (can('review:read')) {
    const branchSelect = h(
      'select',
      { class: 'select', 'aria-label': 'Outlet for Google reviews' },
      branches.map((branch) =>
        h('option', { value: branch.id }, `${branch.code} — ${branch.name}`),
      ),
    );
    const loadButton = h(
      'button',
      { class: 'btn btn--primary', type: 'button', onclick: loadReviews },
      icon('sync'),
      'Fetch reviews',
    );
    const reviewStatus = h(
      'p',
      { class: 'muted', role: 'status' },
      'Choose an outlet and fetch reviews on demand.',
    );

    async function loadReviews() {
      if (!branchSelect.value) {
        reviewStatus.textContent = t('No outlet is available in your access scope.');
        return;
      }
      loadButton.disabled = true;
      reviewStatus.textContent = t('Fetching current Google reviews…');
      outletReviews.replaceChildren();
      try {
        const { data } = await api(`/reviews/outlets/${encodeURIComponent(branchSelect.value)}`);
        reviewStatus.textContent = `${data.branch.name} · ${t('Google rating')} ${data.rating ?? '—'} / 5 · ${number(data.userRatingCount)} ${t('ratings')}`;
        const attribution = h(
          'p',
          { class: 'review-attribution' },
          data.googleMapsUri
            ? h(
                'a',
                {
                  href: data.googleMapsUri,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                },
                'Google Maps',
              )
            : 'Google Maps',
          ' · Reviews shown live and not stored by this CRM.',
        );
        outletReviews.replaceChildren(attribution, ...data.reviews.map(reviewCard));
      } catch (error) {
        reviewStatus.textContent = error.message;
      } finally {
        loadButton.disabled = false;
      }
    }

    sections.push(
      h(
        'section',
        { class: 'card marketing-section' },
        h(
          'div',
          { class: 'card__header' },
          h('h2', {}, icon('comments'), 'Google Reviews'),
          h('span', { class: 'muted' }, 'Fetched only when requested'),
        ),
        h(
          'div',
          { class: 'card__body marketing-stack' },
          h('div', { class: 'toolbar' }, branchSelect, loadButton),
          reviewStatus,
          outletReviews,
        ),
      ),
    );
  }

  if (can('blast:read')) {
    const campaignList = h('div', { class: 'marketing-table' });
    const composeStatus = h('p', { class: 'muted', role: 'status' });
    const name = h('input', {
      class: 'input',
      maxLength: 120,
      placeholder: 'Campaign name',
    });
    const templateName = h('input', {
      class: 'input',
      maxLength: 512,
      placeholder: 'Approved Meta template name',
    });
    const languageCode = h('input', {
      class: 'input',
      value: 'id',
      maxLength: 16,
      placeholder: 'Template language (for example id)',
    });
    const city = h('input', {
      class: 'input',
      maxLength: 100,
      placeholder: 'City (optional)',
    });
    const tierCode = h('input', {
      class: 'input',
      maxLength: 16,
      placeholder: 'Tier (optional)',
    });
    const lastTransactionDays = h('input', {
      class: 'input',
      type: 'number',
      min: 1,
      max: 3650,
      placeholder: 'Transaction within days',
    });
    const personalizeName = h('input', { type: 'checkbox' });
    const scheduleAt = h('input', {
      class: 'input',
      type: 'datetime-local',
      value: localDateTimeInput(),
    });
    const channelInputs = CHANNELS.map((channel) => ({
      channel,
      input: h('input', { type: 'checkbox', value: channel }),
    }));
    let previewCount = null;
    const invalidatePreview = () => {
      previewCount = null;
      composeStatus.textContent = 'Audience filters changed; preview the audience again.';
    };
    [city, tierCode, lastTransactionDays].forEach((input) =>
      input.addEventListener('input', invalidatePreview),
    );
    channelInputs.forEach(({ input }) => input.addEventListener('change', invalidatePreview));

    function criteria() {
      return {
        city: city.value.trim() || undefined,
        tierCode: tierCode.value.trim() || undefined,
        channels: channelInputs.filter(({ input }) => input.checked).map(({ channel }) => channel),
        lastTransactionDays: lastTransactionDays.value
          ? Number(lastTransactionDays.value)
          : undefined,
      };
    }

    async function loadCampaigns() {
      const { data } = await api('/blasts');
      campaignList.replaceChildren(
        table(
          [
            { label: 'Campaign', render: (row) => row.name },
            {
              label: 'Template',
              render: (row) => `${row.templateName} · ${row.languageCode}`,
            },
            { label: 'Status', render: (row) => row.status },
            {
              label: 'Scheduled',
              render: (row) => (row.scheduledAt ? date(row.scheduledAt) : '—'),
            },
            {
              label: 'Sent',
              align: 'right',
              render: (row) => number(row.sentCount),
            },
            {
              label: 'Failed',
              align: 'right',
              render: (row) => number(row.failedCount),
            },
            {
              label: 'Skipped',
              align: 'right',
              render: (row) => number(row.skippedCount),
            },
            {
              label: 'Actions',
              render: (row) =>
                can('blast:manage') && ['DRAFT', 'SCHEDULED'].includes(row.status)
                  ? h(
                      'div',
                      { class: 'toolbar' },
                      row.status === 'DRAFT' &&
                        h(
                          'button',
                          {
                            class: 'btn btn--primary btn--sm',
                            type: 'button',
                            onclick: () => scheduleCampaign(row),
                          },
                          'Schedule',
                        ),
                      h(
                        'button',
                        {
                          class: 'btn btn--ghost btn--sm',
                          type: 'button',
                          onclick: () => cancelCampaign(row),
                        },
                        'Cancel',
                      ),
                    )
                  : '—',
            },
          ],
          data,
          { emptyText: 'No blast campaigns yet' },
        ),
      );
    }

    async function scheduleCampaign(row) {
      if (!scheduleAt.value) {
        toast('Choose a schedule date and time', 'error');
        return;
      }
      try {
        await api(`/blasts/${row.id}/schedule`, {
          method: 'POST',
          body: { scheduledAt: new Date(scheduleAt.value).toISOString() },
        });
        toast('Campaign scheduled');
        await loadCampaigns();
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function cancelCampaign(row) {
      try {
        await api(`/blasts/${row.id}/cancel`, { method: 'POST', body: {} });
        toast('Campaign cancelled');
        await loadCampaigns();
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function preview() {
      try {
        const { data } = await api('/blasts/preview', {
          method: 'POST',
          body: { criteria: criteria() },
        });
        previewCount = data.eligibleCustomers;
        composeStatus.textContent = `${number(previewCount)} ${t('customers have active marketing consent and match')}. ${t('No personal data is shown.')}`;
      } catch (error) {
        composeStatus.textContent = error.message;
        previewCount = null;
      }
    }

    async function createDraft() {
      if (previewCount === null) {
        composeStatus.textContent = 'Preview the consented audience before creating a draft.';
        return;
      }
      try {
        await api('/blasts', {
          method: 'POST',
          body: {
            name: name.value,
            templateName: templateName.value,
            languageCode: languageCode.value,
            personalizeName: personalizeName.checked,
            criteria: criteria(),
          },
        });
        toast('Draft created');
        composeStatus.textContent = '';
        await loadCampaigns();
      } catch (error) {
        composeStatus.textContent = error.message;
      }
    }

    const compose = can('blast:manage')
      ? h(
          'div',
          { class: 'card marketing-section' },
          h(
            'div',
            { class: 'card__header' },
            h('h2', {}, icon('comments'), 'Create WhatsApp blast'),
          ),
          h(
            'div',
            { class: 'card__body marketing-stack' },
            h(
              'div',
              { class: 'marketing-form-grid' },
              name,
              templateName,
              languageCode,
              city,
              tierCode,
              lastTransactionDays,
            ),
            h(
              'fieldset',
              { class: 'marketing-channel-options' },
              h('legend', {}, 'Audience channel (optional)'),
              channelInputs.map(({ channel, input }) =>
                h('label', { class: 'check-option' }, input, channel.replaceAll('_', ' ')),
              ),
            ),
            h(
              'label',
              { class: 'check-option' },
              personalizeName,
              'Personalize template with the customer first name',
            ),
            h('p', { class: 'muted' }, 'Schedule time (local time)'),
            scheduleAt,
            h(
              'div',
              { class: 'toolbar' },
              h(
                'button',
                { class: 'btn btn--ghost', type: 'button', onclick: preview },
                'Preview audience',
              ),
              h(
                'button',
                {
                  class: 'btn btn--primary',
                  type: 'button',
                  onclick: createDraft,
                },
                'Create draft',
              ),
            ),
            composeStatus,
          ),
        )
      : null;

    sections.push(
      compose,
      h(
        'section',
        { class: 'card marketing-section' },
        h('div', { class: 'card__header' }, h('h2', {}, icon('history'), 'WhatsApp campaigns')),
        h('div', { class: 'card__body marketing-table' }, campaignList),
      ),
    );
    await loadCampaigns();
  }

  view.replaceChildren(h('div', { class: 'marketing-page' }, sections));
}
