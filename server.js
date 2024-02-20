const express = require("express");
const mysql = require("mysql2");
const path = require("path");
const pluralize = require("pluralize");
const cors = require("cors");
const solrClient = require("solr-client");

const app = express();
app.use(cors({ origin: "*" }));
const SOLR_URL = process.env.SOLR_URL || "http://solr:8983/solr";
const BASE_URL = `${SOLR_URL}product`;
const PORT = 3000;
const ITEMS_PER_PAGE = 5;

const connection = mysql.createConnection({
  host: "sql6.freesqldatabase.com",
  user: "sql6685139",
  password: "aJsGzE9eIr",
  database: "sql6685139",
});

connection.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL: " + err.stack);
    return;
  }
  console.log("Connected to MySQL as id " + connection.threadId);
});

function singularizeWord(word) {
  const words = word.split(/\s+/);
  const singularizedWords = words.map((word) => pluralize.singular(word));
  const singularizedString = singularizedWords.join(" ");
  return singularizedString;
}

const solrClients = solrClient.createClient({
  host: "solr",
  port: "8983",
  core: "product",
  protocol: "http",
}
);


async function indexData(data) {
  try {
    console.log(data);
    let response = await solrClients.add(data);

  } catch (error) {
    console.error("Error indexing data: ", error);
  }
}


connection.query("SELECT * FROM product", async (err, results) => {
  if (err) {
    console.error("Error executing MySQL query: " + err.stack);
    return;
  }

  for (const product of results) {
    try {
      const document = {
        id: product.product_id,
        brand: product.brand,
        product_name: product.product_name,
        category_name: product.category_name,
        price: product.price,
      };
      await indexData(document);
    } catch (error) {
      console.error("Error indexing document:", error);
    }
  }
});


app.get("/api/search", async (req, res) => {
  console.log("hello")
  try {
    let query = req.query.q;
    let less = ["under", "below", "less", "within", "down", "lesser", "in"];
    let greater = ["over", "above", "greater", "up", "from"];
    let extra = [
      ",",
      ".",
      "/",
      ":",
      "[",
      "]",
      "rs",
      "amt",
      "+",
      "than",
      "Amount",
      "rupees",
      "Price",
    ];

    extra.forEach((val) => {
      if (query.includes(val)) {
        query = query.replace(val, "");
      }
    });

    let decide = null;
    let value = null;
    query = singularizeWord(query);
    let data = query;
    let solrUrl = `${BASE_URL}/select?q=`;

    for (let i = 0; i < less.length; i++) {
      const val = less[i];
      if (query.includes(val)) {
        decide = "lte";
        value = parseFloat(query.split(val)[1]);
        data = query.split(val)[0].trim();
        break;
      }
    }

    greater.forEach((val) => {
      if (query.includes(val) && !query.includes("to")) {
        decide = "gte";
        value = parseFloat(query.split(val)[1]);
        data = query.split(val)[0].trim();
      }
    });

    let priceFilter = null;

    if (query.includes("from") && query.includes("to")) {
      let betweenValues = query.split("from")[1].split("to");
      data = query.split("from")[0].trim();
      
      priceFilter = `fq=price:[${betweenValues[0]} TO ${betweenValues[1]}]`;
    }

    if (query.includes("between")) {
      let betweenValues = query.split("between")[1].split("and");
      data = query.split("between")[0].trim();
      priceFilter = `fq=price:[${betweenValues[0]} TO ${betweenValues[1]}]`;
    } 
    else if (data.includes("and")) {
      data = data.split("and");
      data.forEach((d) => {
        solrUrl += `(${encodeURIComponent("brand:" + d)}*)(${encodeURIComponent(
          "product_name:" + d
        )}*)(${encodeURIComponent("category_name:" + d)}*)`;
      });
    } 
    else {
      if (data.includes(" ")) {
        let tem = data.split(" ");
        for (let i = 0; i < tem.length; i++) {
          solrUrl += `(${encodeURIComponent(
            "brand:" + tem[i]
          )})(${encodeURIComponent(
            "product_name:" + tem[i]
          )}*)(${encodeURIComponent("category_name:" + tem[i])}*)`;
        }
      } 
      else {
        solrUrl += `(${encodeURIComponent(
          "brand:" + data
        )}*)(${encodeURIComponent(
          "product_name:" + data
        )}*)(${encodeURIComponent("category_name:" + data)}*)`;
      }
    }

    if (decide && !isNaN(value)) {
      priceFilter = `fq=price:${
        decide == "lte" ? "[* TO " + value + "]" : "[" + value + " TO *]"
      }`;
    }


    if (priceFilter) {
      solrUrl += `&${priceFilter}`;
    }

    solrUrl += "&rows=30";
    console.log(solrUrl);
    const response = await fetch(solrUrl);
    if (response.ok) {
      const jsonResponse = await response.json();
      const searchResults = jsonResponse.response.docs;
      res.json({ results: searchResults });
    } else {
      console.error(`Error: ${response.status} - ${response.statusText}`);
      res.status(response.status).send("Error fetching data from Solr");
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal server error");
  }
});

app.get("/categories", (req, res) => {
  console.log("cate");

  connection.query("SELECT * FROM category", (err, results) => {
    if (err) {
      console.error("Error executing MySQL query: " + err.stack);
      res
        .status(500)
        .json({ error: "Error retrieving categories from database" });
      return;
    }
    res.json(results);
  });
});

app.get("/products", (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const offset = (page - 1) * ITEMS_PER_PAGE;

  connection.query(
    "SELECT *, (SELECT COUNT(*) FROM product) as total_count FROM product LIMIT ?, ?",
    [offset, ITEMS_PER_PAGE],
    (err, results) => {
      if (err) {
        console.error("Error executing MySQL query: " + err.stack);
        res
          .status(500)
          .json({ error: "Error retrieving products from database" });
        return;
      }

      if (results.length === 0) {
        res.status(404).json({ error: "No products found" });
        return;
      }

      const totalCount = results[0].total_count;
      const hasNextPage = offset + results.length < totalCount;
      res.json({ results, hasNextPage, totalCount });
    }
  );
});

app.get("/products/:categoryID", (req, res) => {
  console.log("prod");

  const categoryID = req.params.categoryID;
  const page = parseInt(req.query.page) || 1;
  const offset = (page - 1) * ITEMS_PER_PAGE;

  connection.query(
    "SELECT *, (SELECT COUNT(*) FROM product WHERE category_id = ?) as total_count FROM product WHERE category_id = ? LIMIT ?, ?",
    [categoryID, categoryID, offset, ITEMS_PER_PAGE],
    (err, results) => {
      if (err) {
        console.error("Error executing MySQL query: " + err.stack);
        res
          .status(500)
          .json({ error: "Error retrieving products from database" });
        return;
      }

      if (results.length === 0) {
        res.status(404).json({ error: "No products found" });
        return;
      }
      const totalCount = results[0].total_count;
      const hasNextPage = offset + results.length < totalCount;
      res.json({ results, hasNextPage, totalCount });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
