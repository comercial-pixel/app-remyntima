// server.js — Fênix API (CommonJS + Render-friendly)
const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json());

// ---- CONFIG DB (host + porta fixa; sem instanceName) ----
const dbConfig = {
  server: process.env.DB_HOST || process.env.DB_SERVER || 'fenixsys.emartim.com.br',
  port: parseInt(process.env.DB_PORT || '20902', 10), // <- importante para seu ambiente
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'RemyntimaFenix',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: (process.env.DB_ENCRYPT || 'false') === 'true',
    trustServerCertificate: (process.env.DB_TRUST_SERVER_CERTIFICATE || 'true') === true,
    enableArithAbort: true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// Mantém um pool global (não feche em cada requisição)
let pool = null;

// Conectar com tentativas, sem derrubar o processo
async function connectWithRetry(retries = 10, delayMs = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      pool = await sql.connect(dbConfig);
      console.log('✅ DB conectado');
      return pool;
    } catch (err) {
      console.error(`❌ Tentativa ${i} falhou: ${err.message}`);
      if (i === retries) {
        console.warn('⚠️ Não conectou ao DB; API segue online sem DB');
        return null;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Garante um pool pronto (1 tentativa rápida on-demand)
async function getPool() {
  if (pool && pool.connected) return pool;
  try {
    pool = await sql.connect(dbConfig);
    return pool;
  } catch {
    return null;
  }
}

// ---- QUERIES (as suas, sem alterações) ----
// Nota: Para Stored Procedures, o SQL é executado diretamente na rota, não aqui.
// Esta seção serve mais para queries SQL diretas e reutilizáveis.
const queries = {
    lancamentos_diarios: `WITH CTE_Dados AS (
    -- Seleção de dados relevantes com as condições do WHERE aplicadas
    SELECT 
        cad_emp.EMP_NMR,
        cad_ipe.IPE_COD,
        cad_ipe.PED_COD,
        cad_ipe.IPE_VTL,
        cad_ipe.IPE_VLC,
        cad_ipe.IPE_PPM,
        cad_ipe.IPE_CDI, 
        cad_rev.REV_COD,
        cad_ped.PED_COD AS PEDIDO_ID -- Adicionado para contagem de pedidos
    FROM cad_ipe
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod -- Relação com pedidos
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod -- Relação com empresas
    LEFT JOIN cad_rev ON cad_rev.REV_COD = cad_ped.REV_COD -- Relação opcional com revisões
    WHERE 
        cad_ped.PED_STA IN ('CON', 'ACE', 'DEV', 'PND', 'ESP', 'SPC') -- Status permitidos
        AND CONVERT(varchar, cad_ipe.IPE_DTL, 112) = CONVERT(varchar, GETDATE(), 112) -- Data do dia atual
        AND cad_ped.PED_TIP = 11 -- Apenas tipo de pedido 11
)
SELECT 
    dados.EMP_NMR,
    'Lançamento' AS Tipo,

    -- Métricas para quando IPE_CDI é NULL
    COUNT(CASE WHEN dados.IPE_CDI IS NULL THEN dados.IPE_COD ELSE NULL END) AS Qtde,
    SUM(CASE WHEN dados.IPE_CDI IS NULL THEN dados.IPE_VTL ELSE 0 END) AS Valor,
    SUM(CASE WHEN dados.IPE_CDI IS NULL THEN dados.IPE_VLC ELSE 0 END) AS Custo,

    -- Quantidade de PEDIDOS únicos (sem distinção de IPE_CDI)
    COUNT(DISTINCT dados.PEDIDO_ID) AS [QTDE PEDIDOS], -- Adicionado a coluna de pedidos

    -- Métricas para quando IPE_CDI IS NOT NULL
    COUNT(CASE WHEN dados.IPE_CDI IS NOT NULL THEN dados.IPE_COD ELSE NULL END) AS Remarcacao, -- Contagem de itens com CDI
    SUM(CASE WHEN dados.IPE_CDI IS NOT NULL THEN dados.IPE_VTL ELSE 0 END) AS Valor_Remarcacao,
    SUM(CASE WHEN dados.IPE_CDI IS NOT NULL THEN dados.IPE_VLC ELSE 0 END) AS Custo_Remarcacao,

    -- Quantidade de revisões (sem distinção de IPE_CDI)
    COUNT(DISTINCT dados.REV_COD) AS [QTDE REV]
FROM 
    CTE_Dados dados
GROUP BY 
    dados.EMP_NMR
ORDER BY 
    Valor DESC;`,
    devolucoes_diarias: `SELECT cad_emp.EMP_NMR, 'Devolução' AS Tipo, COUNT(DISTINCT cad_ped.REV_COD) as [QTDE REV], COUNT(cad_ipe.IPE_COD) AS Qtde, COUNT(DISTINCT cad_ipe.PED_COD) as [QTDE PEDIDOS], SUM(cad_ipe.IPE_VTL) AS Valor, SUM(cad_ipe.IPE_VLC) AS Custo FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and CONVERT(varchar,cad_ipe.IPE_DDV,112) = CONVERT(varchar,GETDATE(),112) and cad_ped.PED_TIP = 11 GROUP BY cad_emp.EMP_NMR ORDER BY Valor DESC`,
    lancamentos_acumulados: `WITH CTE_Dados AS (
    -- Seleciona todos os dados relevantes com base no WHERE fornecido
    SELECT 
        cad_emp.EMP_NMR,
        cad_ipe.IPE_COD,
        cad_ipe.PED_COD,
        cad_ipe.IPE_VTL,
        cad_ipe.IPE_VLC,
        cad_ipe.IPE_PPM,
        cad_ipe.IPE_CDI, 
        cad_ipe.IPE_DTL,
        cad_rev.REV_COD,
        cad_ped.PED_COD AS PEDIDO_ID -- Adicionado para contagem de pedidos
    FROM cad_ipe
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod -- Junção com pedidos
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod -- Junção com empresas
    LEFT JOIN cad_rev ON cad_rev.REV_COD = cad_ped.REV_COD -- Junção opcional com revisões
    WHERE 
        cad_ped.PED_STA IN ('CON', 'ACE', 'DEV', 'PND', 'ESP', 'SPC') -- Status permitidos
        AND CONVERT(varchar,cad_ipe.IPE_DTL,112) >= CONVERT(varchar,DATEADD(DAY, 1, EOMONTH(GETDATE(), -1)),112) -- Data de início (1º dia do mês atual)
        AND CONVERT(varchar,cad_ipe.IPE_DTL,112) <= CONVERT(varchar,GETDATE(),112) -- Data final (dia atual)
        AND cad_ped.PED_TIP = 11 -- Apenas tipo de pedido 11
)
SELECT 
    dados.EMP_NMR,
    'Lançamento' AS Tipo,

    -- Quando IPE_CDI IS NULL
    COUNT(CASE WHEN dados.IPE_CDI IS NULL THEN dados.IPE_COD ELSE NULL END) AS Qtde,
    SUM(CASE WHEN dados.IPE_CDI IS NULL THEN dados.IPE_VTL ELSE 0 END) AS Valor,
    SUM(CASE WHEN dados.IPE_CDI IS NULL THEN dados.IPE_VLC ELSE 0 END) AS Custo,

    -- Quantidade de PEDIDOS únicos (independe de IPE_CDI)
    COUNT(DISTINCT dados.PEDIDO_ID) AS [QTDE PEDIDOS], -- Adicionado a coluna de pedidos

    -- Quando IPE_CDI IS NOT NULL
    SUM(CASE WHEN dados.IPE_CDI IS NOT NULL THEN 1 ELSE 0 END) AS Remarcacao, -- Contagem de itens com CDI
    SUM(CASE WHEN dados.IPE_CDI IS NOT NULL THEN dados.IPE_VTL ELSE 0 END) AS Valor_Remarcacao,
    SUM(CASE WHEN dados.IPE_CDI IS NOT NULL THEN dados.IPE_VLC ELSE 0 END) AS Custo_Remarcacao,

    -- Quantidade de revisões (independe de IPE_CDI)
    COUNT(DISTINCT dados.REV_COD) AS [QTDE REV]
FROM 
    CTE_Dados dados
GROUP BY 
    dados.EMP_NMR
ORDER BY 
    Valor DESC;`,
    devolucoes_acumuladas: `SELECT cad_emp.EMP_NMR, 'Devolução' AS Tipo, COUNT(DISTINCT cad_ped.REV_COD) as [QTDE REV], COUNT(cad_ipe.IPE_COD) AS Qtde, COUNT(DISTINCT cad_ipe.PED_COD) as [QTDE PEDIDOS], SUM(cad_ipe.IPE_VTL) AS Valor, SUM(cad_ipe.IPE_VLC) AS Custo FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and CONVERT(varchar,cad_ipe.IPE_DDV,112) >= CONVERT(varchar,DATEADD(DAY, 1, EOMONTH(GETDATE(), -1)),112) AND CONVERT(varchar,cad_ipe.IPE_DDV,112) <= CONVERT(varchar,GETDATE(),112) and cad_ped.PED_TIP = 11 GROUP BY cad_emp.EMP_NMR ORDER BY Valor DESC`,
    lancamentos_historico: `SELECT CONVERT(varchar,cad_ipe.IPE_DTL,112) as data_ref, cad_emp.EMP_NMR, SUM(cad_ipe.IPE_VTL) as valor FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and cad_ipe.IPE_DTL >= DATEADD(day, -30, GETDATE()) and cad_ipe.IPE_DTL <= GETDATE() and cad_ped.PED_TIP = 11 GROUP BY CONVERT(varchar,cad_ipe.IPE_DTL,112), cad_emp.EMP_NMR`,
    devolucoes_historico: `SELECT CONVERT(varchar,cad_ipe.IPE_DDV,112) as data_ref, cad_emp.EMP_NMR, SUM(cad_ipe.IPE_VTL) as valor FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and cad_ipe.IPE_DDV >= DATEADD(day, -30, GETDATE()) and cad_ipe.IPE_DDV <= GETDATE() and cad_ped.PED_TIP = 11 GROUP BY CONVERT(varchar,cad_ipe.IPE_DDV,112), cad_emp.EMP_NMR`
};

// Função auxiliar para formatar CPF (remove caracteres especiais e valida)
function formatCPF(cpf) {
  if (!cpf) return null;
  
  // Remove tudo que não é dígito
  const digits = cpf.replace(/\D/g, '');
  
  // Valida se tem 11 dígitos
  if (digits.length !== 11) return null;
  
  return digits;
}

// ---- ROTAS ----

// Rota de teste
app.get('/test', (req, res) => {
  res.json({ 
    status: 'API funcionando', 
    timestamp: new Date().toISOString(),
    database: pool ? 'Conectado' : 'Desconectado'
  });
});

// Lançamentos do dia
app.get('/api/lancamentos-diarios', async (req, res) => {
  const currentPool = await getPool();
  if (!currentPool) {
    return res.status(503).json({ error: 'DB não disponível' });
  }

  try {
    const result = await currentPool.request().query(queries.lancamentos_diarios);
    res.json(result.recordset);
  } catch (err) {
    console.error('Erro em lancamentos-diarios:', err.message);
    res.status(500).json({ error: 'Erro na consulta', details: err.message });
  }
});

// Devoluções do dia
app.get('/api/devolucoes-diarias', async (req, res) => {
  const currentPool = await getPool();
  if (!currentPool) {
    return res.status(503).json({ error: 'DB não disponível' });
  }

  try {
    const result = await currentPool.request().query(queries.devolucoes_diarias);
    res.json(result.recordset);
  } catch (err) {
    console.error('Erro em devolucoes-diarias:', err.message);
    res.status(500).json({ error: 'Erro na consulta', details: err.message });
  }
});

// Lançamentos acumulados do mês
app.get('/api/lancamentos-acumulados', async (req, res) => {
  const currentPool = await getPool();
  if (!currentPool) {
    return res.status(503).json({ error: 'DB não disponível' });
  }

  try {
    const result = await currentPool.request().query(queries.lancamentos_acumulados);
    res.json(result.recordset);
  } catch (err) {
    console.error('Erro em lancamentos-acumulados:', err.message);
    res.status(500).json({ error: 'Erro na consulta', details: err.message });
  }
});

// Devoluções acumuladas do mês
app.get('/api/devolucoes-acumuladas', async (req, res) => {
  const currentPool = await getPool();
  if (!currentPool) {
    return res.status(503).json({ error: 'DB não disponível' });
  }

  try {
    const result = await currentPool.request().query(queries.devolucoes_acumuladas);
    res.json(result.recordset);
  } catch (err) {
    console.error('Erro em devolucoes-acumuladas:', err.message);
    res.status(500).json({ error: 'Erro na consulta', details: err.message });
  }
});


// NOVO ENDPOINT: Validação de CPF para login da revendedora
app.post('/api/validate-cpf', async (req, res) => {
  const currentPool = await getPool();
  if (!currentPool) {
    return res.status(503).json({ 
      success: false, 
      error: 'Serviço de validação temporariamente indisponível.' 
    });
  }

  try {
    const { cpf } = req.body;

    // Validação básica do CPF
    const cpfFormatted = formatCPF(cpf);
    if (!cpfFormatted) {
      return res.status(400).json({
        success: false,
        error: 'CPF inválido. Verifique se possui 11 dígitos.'
      });
    }

    console.log(`[Validação CPF] Consultando CPF: ${cpfFormatted}`);

    // Fazer um SELECT direto na tabela cad_rev
    const result = await currentPool.request()
      .input('cpf', sql.VarChar(11), cpfFormatted)
      .query(`SELECT cad_emp.EMP_NMR, cad_rev.REV_COD, REV_NOM, REV_CPF, REV_EMA, REV_TEL, REV_CEL,cad_cli.CLI_RAZ 
              FROM cad_rev
              JOIN cli_rev on cli_rev.REV_COD = cad_rev.REV_COD and cli_rev.STATUS = 1
              JOIN cad_cli on cad_cli.CLI_COD = cli_rev.CLI_COD
              JOIN cad_emp on cad_emp.EMP_COD = cad_cli.EMP_COD 
              WHERE REV_CPF = @cpf`);

    // Verifica se encontrou algum registro
    if (result.recordset && result.recordset.length > 0) {
      const revendedora = result.recordset[0];
      
      console.log(`[Validação CPF] CPF encontrado: ${revendedora.REV_NOM || 'Nome não disponível'}`);
      
      return res.json({
        success: true,
        message: 'CPF válido',
        data: {
          REV_COD: revendedora.REV_COD,
          REV_NOM: revendedora.REV_NOM, 
          REV_CPF: revendedora.REV_CPF,
          REV_EMA: revendedora.REV_EMA || null,
          REV_TEL: revendedora.REV_TEL || null,
          REV_CEL: revendedora.REV_CEL || null,
          // Linha corrigida/adicionada para incluir EMP_NMR
          EMP_NMR: revendedora.EMP_NMR || null,
          CLI_RAZ: revendedora.CLI_RAZ || null 
        }
      });
    } else {
      console.log(`[Validação CPF] CPF não encontrado: ${cpfFormatted}`);
      
      return res.status(404).json({
        success: false,
        error: 'CPF não encontrado. Verifique se você está cadastrada como revendedora.'
      });
    }

  } catch (err) {
    console.error('[Validação CPF] Erro ao validar CPF:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Erro interno ao validar o CPF.',
      details: err.message
    });
  }
});


// NOVO ENDPOINT: para a Stored Procedure de Análise de Revendedoras (sp_returnConsultaRevComissao)
app.post('/api/sp-rev-comissao', async (req, res) => {
    const { whereClause } = req.body;

    if (!whereClause) {
        return res.status(400).json({ success: false, error: 'Parâmetro "whereClause" é obrigatório.' });
    }

    try {
        const p = await getPool();
        if (!p) {
            console.error('[API Render] Sem conexão com o banco para sp-rev-comissao');
            return res.status(503).json({ success: false, error: 'Serviço indisponível: Sem conexão com o banco de dados.' });
        }

        const request = p.request();
        request.input('Where', sql.NVarChar(4000), whereClause);

        console.log(`[API Render] Executando SP 'sp_returnConsultaRevComissao' com WHERE: ${whereClause}`);
        const result = await request.execute('sp_returnConsultaRevComissao');

        res.json({ success: true, data: result.recordset });

    } catch (err) {
        console.error('[API Render] Erro ao executar SP sp_returnConsultaRevComissao:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// NOVO ENDPOINT: para a Stored Procedure sp_CobrancaAcerto
app.post('/api/sp-cobranca-acerto', async (req, res) => {
  try {
    const { emp_cod, atrasado = 0, revCod = 0, tipo = 4, endCompleto = 0 } = req.body;

    if (!emp_cod) {
      return res.status(400).json({ 
        success: false, 
        error: 'Parâmetro emp_cod é obrigatório' 
      });
    }

    const pool = await getPool();
    if (!pool) {
      return res.status(500).json({ 
        success: false, 
        error: 'Não foi possível conectar ao banco de dados' 
      });
    }

    console.log('📊 Executando SP com parâmetros:', { emp_cod, atrasado, revCod, tipo, endCompleto });

    const request = pool.request();
    
    request.input('EMP_COD', sql.Int, parseInt(emp_cod));
    request.input('ATRASADO', sql.Bit, atrasado ? 1 : 0);
    request.input('REV_COD', sql.Int, parseInt(revCod));
    request.input('TIPO', sql.Int, parseInt(tipo));
    request.input('EndCompleto', sql.Bit, endCompleto ? 1 : 0);

    const result = await request.execute('sp_CobrancaAcerto');
    
    console.log(`✅ SP executada com sucesso. Registros: ${result.recordset.length}`);

    res.json({ 
      success: true, 
      data: result.recordset 
    });

  } catch (error) {
    console.error('❌ Erro na SP:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// NOVO ENDPOINT: para a Stored Procedure sp_returnFcsAnaliseParticipacoAcerto
app.post('/api/sp-analise-participacao-acerto', async (req, res) => {
  try {
    // Apenas extraímos o rev_cod do corpo da requisição.
    // emp_cod, inicio e fim serão definidos com valores fixos conforme sua necessidade.
    const { rev_cod: incoming_rev_cod } = req.body;

    // Valores fixos para a chamada da Stored Procedure
    const EMP_COD_FOR_SP = 0;
    const INICIO_FOR_SP = '';
    const FIM_FOR_SP = '';

    // Validamos apenas o rev_cod, pois os outros são fixos e garantidos.
    if (incoming_rev_cod === undefined || incoming_rev_cod === null) {
      return res.status(400).json({
        success: false,
        error: 'O parâmetro REV_COD é obrigatório.'
      });
    }

    const pool = await getPool();
    if (!pool) {
      return res.status(500).json({
        success: false,
        error: 'Não foi possível conectar ao banco de dados.'
      });
    }

    console.log('📊 [sp-analise-participacao-acerto] Executando SP com parâmetros fixos:', {
      EMP_COD: EMP_COD_FOR_SP,
      INICIO: INICIO_FOR_SP,
      FIM: FIM_FOR_SP,
      REV_COD: incoming_rev_cod
    });

    const request = pool.request();

    // Usar os valores fixos para os inputs da Stored Procedure
    request.input('EMP_COD', sql.Int, EMP_COD_FOR_SP);
    request.input('INICIO', sql.VarChar(10), INICIO_FOR_SP);
    request.input('FIM', sql.VarChar(10), FIM_FOR_SP);
    request.input('REV_COD', sql.Int, parseInt(incoming_rev_cod)); // Converte para inteiro o rev_cod recebido

    const result = await request.execute('sp_returnFcsAnaliseParticipacoAcerto');

    console.log(`✅ [sp-analise-participacao-acerto] SP executada com sucesso. Registros: ${result.recordset.length}`);

    res.json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error('❌ [sp-analise-participacao-acerto] Erro na SP:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});



// Endpoint para Análise de Participação de Produtos - ATUALIZADO
app.post('/api/sp-AnaliseParticipacaoDeProdutos', async (req, res) => {
  try {
    const { emp_cod, inicio, fim, FUN_COD = 0, TP_ANALISE = 1, TP_DATA_FILTRO = 1, TCT_COD = 1 } = req.body;
    
    // Validar parâmetros obrigatórios
    if (emp_cod === undefined || emp_cod === null || !inicio || !fim) { // Ajuste para permitir emp_cod = 0
      return res.status(400).json({ 
        success: false, 
        error: 'Parâmetros emp_cod, inicio e fim são obrigatórios' 
      });
    }

    const logParams = { emp_cod, inicio, fim, FUN_COD, TP_ANALISE, TP_DATA_FILTRO, TCT_COD };
    console.log(`[sp_AnaliseParticipacaoDeProdutos] Executando com parâmetros:`, logParams);

    const pool = await getPool();
    if (!pool) {
        return res.status(503).json({ success: false, error: 'Serviço indisponível: Sem conexão com o banco de dados.' });
    }
    
    const request = pool.request();
    
    // Configurar parâmetros da stored procedure com tipos explícitos
    request.input('EMP_COD', sql.Int, parseInt(emp_cod || '0')); // Adicionado fallback para 0
    request.input('inicio', sql.VarChar(10), inicio);
    request.input('Fim', sql.VarChar(10), fim);
    request.input('FUN_COD', sql.Int, parseInt(FUN_COD));
    request.input('TP_ANALISE', sql.Int, parseInt(TP_ANALISE));
    request.input('TP_DATA_FILTRO', sql.Int, parseInt(TP_DATA_FILTRO));
    request.input('TCT_COD', sql.Int, parseInt(TCT_COD));
    
    // Executar a stored procedure
    const result = await request.execute('sp_AnaliseParticipacaoDeProdutos');
    
    console.log(`[sp_AnaliseParticipacaoDeProdutos] Sucesso. Registros retornados: ${result.recordset.length}`);
    
    res.json({
      success: true,
      data: result.recordset
    });
    
  } catch (error) {
    console.error('Erro na SP sp_AnaliseParticipacaoDeProdutos:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// NOVO ENDPOINT: Para a Stored Procedure sp_ConsultaIpeViaRev
app.post('/api/sp-consulta-ipe-via-rev', async (req, res) => {
  try {
    const { REV_COD } = req.body;

    if (REV_COD === undefined || REV_COD === null) { // Ajuste para permitir REV_COD = 0
      return res.status(400).json({
        success: false,
        error: 'Parâmetro REV_COD é obrigatório.'
      });
    }

    const pool = await getPool();
    if (!pool) {
      return res.status(500).json({
        success: false,
        error: 'Não foi possível conectar ao banco de dados.'
      });
    }

    console.log(`📊 [sp-ConsultaIpeViaRev] Executando SP para REV_COD: ${REV_COD}`);

    const request = pool.request();
    request.input('REV_COD', sql.Int, parseInt(REV_COD || '0')); // Adicionado fallback para 0

    const result = await request.execute('sp_ConsultaIpeViaRev');

    console.log(`✅ [sp-ConsultaIpeViaRev] SP executada com sucesso. Registros: ${result.recordset.length}`);

    res.json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error('❌ [sp-ConsultaIpeViaRev] Erro na SP:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Status do DB: hora do SQL + contagens/valores do dia (para acompanhar atualização)
app.get('/api/db-status', async (req, res) => {
  try {
    const p = await getPool();
    if (!p) return res.status(503).json({ success: false, error: 'Sem conexão com o banco' });
    const q = `
      SELECT
        SYSDATETIME() AS dbTime,
        CONVERT(date, GETDATE()) AS hoje,
        (SELECT COUNT(*)              FROM cad_ipe WHERE CAST(IPE_DTL AS date) = CAST(GETDATE() AS date)) AS lancamentosHoje,
        (SELECT ISNULL(SUM(IPE_VTL),0) FROM cad_ipe WHERE CAST(IPE_DTL AS date) = CAST(GETDATE() AS date)) AS valorLancamentosHoje,
        (SELECT COUNT(*)              FROM cad_ipe WHERE CAST(IPE_DDV AS date) = CAST(GETDATE() AS date)) AS devolucoesHoje,
        (SELECT ISNULL(SUM(IPE_VTL),0) FROM cad_ipe WHERE CAST(IPE_DDV AS date) = CAST(GETDATE() AS date)) AS valorDevolucoesHoje
    `;
    const r = await p.request().query(q);
    res.json({ success: true, ...r.recordset[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// NOVO ENDPOINT: Para a Stored Procedure sp_ConsultaCadFcs
app.post('/api/sp-consulta-cad-fcs', async (req, res) => {
  try {
    const { EMP_COD = 0, INI, FIM } = req.body;

    if (!INI || !FIM) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetros INI e FIM são obrigatórios.'
      });
    }

    const pool = await getPool();
    if (!pool) {
      return res.status(500).json({
        success: false,
        error: 'Não foi possível conectar ao banco de dados.'
      });
    }

    console.log(`📊 [sp-consulta-cad-fcs] Executando SP com parâmetros:`, { EMP_COD, INI, FIM });

    const request = pool.request();
    request.input('EMP_COD', sql.Int, parseInt(EMP_COD || '0'));
    request.input('INI', sql.VarChar(10), INI);
    request.input('FIM', sql.VarChar(10), FIM);

    const result = await request.execute('sp_ConsultaCadFcs');

    console.log(`✅ [sp-consulta-cad-fcs] SP executada com sucesso. Registros: ${result.recordset.length}`);

    res.json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error('❌ [sp-consulta-cad-fcs] Erro na SP:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Sobe HTTP primeiro e tenta o DB em background (não mata o processo se falhar)
app.listen(PORT, HOST, () => {
  console.log(`🚀 API Fenix rodando em http://${HOST}:${PORT}`);
  connectWithRetry().catch(err => console.error('Conector DB erro:', err.message));
});

// Encerramento limpo
process.on('SIGINT', async () => {
  console.log('🛑 Encerrando servidor...');
  try { if (pool) await pool.close(); } catch {}
  process.exit(0);
});