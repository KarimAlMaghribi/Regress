use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::Config;
use native_tls::TlsConnector;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = Config::new();
    config.host("fehmarn.adesso.claims");
    config.port(5432);
    config.dbname("regress");
    config.user("regress");
    config.ssl_mode(tokio_postgres::config::SslMode::Require);

    let tls_connector = TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()?;
    let connector = MakeTlsConnector::new(tls_connector);

    let (client, connection) = config.connect(connector).await?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("connection error: {}", e);
        }
    });

    let row = client.query_one("SELECT version()", &[]).await?;
    let version: String = row.get(0);
    println!("{}", version);

    Ok(())
}
