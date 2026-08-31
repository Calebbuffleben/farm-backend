import { parseCsv } from './csv.util';

describe('parseCsv', () => {
  it('parses comma-delimited with normalized headers', () => {
    const rows = parseCsv(
      'Produtor,Telefone,Fazenda\nJoão Silva,+5566999990000,Santa Fé\n',
    );
    expect(rows).toEqual([
      {
        produtor: 'João Silva',
        telefone: '+5566999990000',
        fazenda: 'Santa Fé',
      },
    ]);
  });

  it('parses semicolon-delimited (Excel pt-BR) and BOM', () => {
    const rows = parseCsv(
      '\uFEFFprodutor;telefone;fazenda\nMaria;+5511;Boa Vista\n',
    );
    expect(rows[0]).toEqual({
      produtor: 'Maria',
      telefone: '+5511',
      fazenda: 'Boa Vista',
    });
  });

  it('handles quoted fields with delimiter and escaped quotes', () => {
    const rows = parseCsv(
      'produtor,fazenda\n"Silva, João","Faz ""Nova"" Era"\n',
    );
    expect(rows[0]).toEqual({
      produtor: 'Silva, João',
      fazenda: 'Faz "Nova" Era',
    });
  });

  it('skips fully empty lines', () => {
    const rows = parseCsv('a,b\n1,2\n\n,\n3,4\n');
    expect(rows).toHaveLength(2);
  });

  it('keeps email column', () => {
    const rows = parseCsv(
      'produtor,email,fazenda\nJoão,ada@fazenda.com,Santa Fé\n',
    );
    expect(rows[0]).toEqual({
      produtor: 'João',
      email: 'ada@fazenda.com',
      fazenda: 'Santa Fé',
    });
  });

  it('normalizes accented headers', () => {
    const rows = parseCsv('Região,Área\nMT,100\n');
    expect(rows[0]).toEqual({ regiao: 'MT', area: '100' });
  });
});
