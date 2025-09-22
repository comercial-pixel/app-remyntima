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
    trustServerCertificate: (process.env.DB_TRUST_SERVER_CERTIFICATE || 'true') === 'true',
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

    -- Métricas para quando IPE_CDI é NOT NULL
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

// ---- ROTAS ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/api/query', async (req, res) => {
  const { queryType } = req.body;
  console.log(`Recebida requisição para query: ${queryType}`);

  const sqlQuery = queries[queryType];
  if (!sqlQuery) {
    console.error(`Query type inválido: ${queryType}`);
    return res.status(400).json({ success: false, message: 'Query type inválido' });
  }

  try {
    const p = await getPool();
    if (!p) throw new Error('Sem conexão com o banco');
    const result = await p.request().query(sqlQuery);
    console.log(`Query ${queryType} executada. Registros: ${result.recordset.length}`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Erro na execução da query SQL:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao processar a query', error: err.message });
  }
});

// NOVO ENDPOINT: para a Stored Procedure de Análise de Revendedoras
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
        // O tipo e o tamanho do parâmetro devem corresponder ao que a SP espera
        request.input('Where', sql.NVarChar(4000), whereClause); // Ajuste o tamanho (4000) se necessário

        console.log(`[API Render] Executando SP 'sp_returnConsultaRevComissao' com WHERE: ${whereClause}`);
        const result = await request.execute('sp_returnConsultaRevComissao');

        res.json({ success: true, data: result.recordset });

    } catch (err) {
        console.error('[API Render] Erro ao executar SP sp_returnConsultaRevComissao:', err.message);
        // Retorna um erro 500 se algo der errado na execução da SP ou conexão
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
    
    // IMPORTANTE: Definir os tipos corretos dos parâmetros
    request.input('EMP_COD', sql.Int, parseInt(emp_cod));
    request.input('ATRASADO', sql.Bit, atrasado ? 1 : 0);
    request.input('RevCod', sql.Int, parseInt(revCod));
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
    const { emp_cod, inicio, fim } = req.body;

    // Validação básica dos parâmetros
    if (!emp_cod || !inicio || !fim) {
      return res.status(400).json({ 
        success: false, 
        error: 'Parâmetros emp_cod, inicio e fim são obrigatórios.' 
      });
    }

    const pool = await getPool();
    if (!pool) {
      return res.status(500).json({ 
        success: false, 
        error: 'Não foi possível conectar ao banco de dados.' 
      });
    }

    console.log('📊 [sp-analise-participacao-acerto] Executando SP com parâmetros:', { emp_cod, inicio, fim });

    const request = pool.request();
    
    // IMPORTANTE: Definir os tipos corretos dos parâmetros para a Stored Procedure
    request.input('EMP_COD', sql.Int, parseInt(emp_cod));
    request.input('INICIO', sql.VarChar(10), inicio); // Formato YYYYMMDD
    request.input('FIM', sql.VarChar(10), fim);     // Formato YYYYMMDD
    request.input('DEV_ANT', sql.Int, 0); // NOVO PARÂMETRO: @DEV_ANT com valor fixo 0

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
    if (!emp_cod || !inicio || !fim) {
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
    request.input('EMP_COD', sql.Int, parseInt(emp_cod));
    request.input('inicio', sql.VarChar(10), inicio);
    request.input('Fim', sql.VarChar(10), fim);
    request.input('FUN_COD', sql.Int, parseInt(FUN_COD));
    request.input('TP_ANALISE', sql.Int, parseInt(TP_ANALISE));
    request.input('TP_DATA_FILTRO', sql.Int, parseInt(TP_DATA_FILTRO));
    request.input('TCT_COD', sql.Int, parseInt(TCT_COD));
    
    // O parâmetro @Fornecedores é do tipo UDTT_cad_for.
    // Como não estamos passando dados para ele, não o adicionamos aqui.
    // Se a SP exigir, o banco retornará um erro específico que podemos tratar.
    
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

//
//
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