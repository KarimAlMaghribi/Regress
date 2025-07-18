/// <reference types="cypress" />

describe('upload flow', () => {
  it('shows preview after ocr', () => {
    cy.intercept('POST', '/upload', { id: 1 });
    cy.intercept('GET', '/uploads/1/status', { status: 'ocr_done' }).as('status');
    cy.intercept('GET', '/pdf/1/layout', { pages: [{ width: 100, height: 100, blocks: [] }] }).as('layout');

    cy.visit('/upload');
    cy.fixture('sample.pdf', 'binary').then(f => {
      const blob = Cypress.Blob.binaryStringToBlob(f, 'application/pdf');
      const file = new File([blob], 'sample.pdf', { type: 'application/pdf' });
      cy.get('[data-testid=drop-input]').selectFile({ contents: file, lastModified: Date.now() }, { force: true });
    });

    cy.wait('@status');
    cy.wait('@layout');
    cy.contains('➡️ Pipeline starten').should('exist');
  });
});
